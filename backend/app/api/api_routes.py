# Expose health, chat completion, and streaming endpoints.
# Translate service results into HTTP responses without putting provider logic in the routes.

import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse

from .api_models import (
    DEVMATE_BACKEND_CAPABILITIES,
    DEVMATE_BACKEND_PROTOCOL_VERSION,
    DEVMATE_BACKEND_SERVICE,
    AskRequest,
    AskResult,
    HealthData,
    HealthResult,
)
from ..chat.chat_service import ChatService
from ..dependencies import get_chat_provider, get_chat_service
from ..errors import BackendApiError
from ..providers.chat_provider import ChatCompletion, ChatProvider, ProviderError
from ..chat.text_tool_calls import classify_text_tool_call_prefix


logger = logging.getLogger(__name__)
api_router = APIRouter()


def _provider_api_error(error: ProviderError) -> BackendApiError:
    return BackendApiError(error.status_code, error.error_code, str(error))


def _stream_line(value: dict[str, object]) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"


@api_router.get("/health", response_model=HealthResult)
async def health(request: Request) -> HealthResult:
    return HealthResult(
        status="ok",
        data=HealthData(
            service=DEVMATE_BACKEND_SERVICE,
            protocolVersion=DEVMATE_BACKEND_PROTOCOL_VERSION,
            capabilities=list(DEVMATE_BACKEND_CAPABILITIES),
            backend="online",
            version=request.app.version,
        ),
    )


@api_router.post("/ask", response_model=AskResult)
async def ask(
    request: AskRequest,
    chat_provider: Annotated[ChatProvider, Depends(get_chat_provider)],
    chat_service: Annotated[ChatService, Depends(get_chat_service)],
    provider_api_key: Annotated[
        str | None,
        Header(alias="X-DevMate-Provider-Key", max_length=10_000),
    ] = None,
) -> AskResult:
    completion_request, enabled_tools, used_files = chat_service.build_completion_request(
        request,
        provider_api_key,
    )
    try:
        completion_value = await chat_provider.complete(completion_request)
    except ProviderError as error:
        raise _provider_api_error(error) from error

    completion = completion_value if isinstance(completion_value, ChatCompletion) else ChatCompletion(
        content=completion_value
    )
    return chat_service.result_from_completion(
        request,
        completion,
        enabled_tools,
        used_files,
        chat_service.completion_token_usage(completion_request, completion),
    )


@api_router.post("/ask/stream")
async def ask_stream(
    request: AskRequest,
    chat_provider: Annotated[ChatProvider, Depends(get_chat_provider)],
    chat_service: Annotated[ChatService, Depends(get_chat_service)],
    provider_api_key: Annotated[
        str | None,
        Header(alias="X-DevMate-Provider-Key", max_length=10_000),
    ] = None,
) -> StreamingResponse:
    completion_request, enabled_tools, used_files = chat_service.build_completion_request(
        request,
        provider_api_key,
    )

    async def event_stream() -> AsyncIterator[str]:
        yield _stream_line({"type": "start"})
        initial_usage = chat_service.completion_token_usage(completion_request, None)
        yield _stream_line({"type": "usage", "usage": initial_usage.model_dump(mode="json")})
        completion: ChatCompletion | None = None
        reasoning_announced = False
        tool_announced = False
        # Hold possible textual tool markup until we know it is ordinary answer text.
        preview_mode: Literal["pending", "answer", "tool"] = "pending"
        preview_buffer = ""
        try:
            stream_method = getattr(chat_provider, "stream", None)
            if callable(stream_method):
                async for event in stream_method(completion_request):
                    if event.kind == "content" and event.text:
                        if preview_mode == "answer":
                            yield _stream_line({"type": "delta", "text": event.text})
                        elif preview_mode == "pending":
                            preview_buffer += event.text
                            preview_mode = classify_text_tool_call_prefix(preview_buffer)
                            if preview_mode == "answer":
                                yield _stream_line({"type": "delta", "text": preview_buffer})
                                preview_buffer = ""
                            elif preview_mode == "tool":
                                preview_buffer = ""
                                if not tool_announced:
                                    tool_announced = True
                                    yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
                    # Send a phase label to the UI, never raw provider reasoning content.
                    elif event.kind == "reasoning" and not reasoning_announced:
                        reasoning_announced = True
                        yield _stream_line({"type": "progress", "phase": "Model is reasoning"})
                    elif event.kind == "tool":
                        if not tool_announced:
                            tool_announced = True
                            yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
                    elif event.kind == "complete" and event.completion:
                        completion = event.completion
            else:
                completion_value = await chat_provider.complete(completion_request)
                completion = completion_value if isinstance(completion_value, ChatCompletion) else ChatCompletion(
                    content=completion_value
                )
                if completion.content:
                    preview_buffer = completion.content
                    preview_mode = classify_text_tool_call_prefix(preview_buffer)

            if not completion:
                raise BackendApiError(
                    502,
                    "provider_invalid_response",
                    "The model provider ended its stream without a final response.",
                )
            completion, converted_text_tool = chat_service.normalize_text_tool_completion(completion)
            if converted_text_tool and not tool_announced:
                tool_announced = True
                yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
            if preview_mode == "pending" and preview_buffer and not converted_text_tool:
                yield _stream_line({"type": "delta", "text": preview_buffer})
            elif preview_mode == "answer" and preview_buffer:
                yield _stream_line({"type": "delta", "text": preview_buffer})
            # Previews are not authoritative; validate the completed result before finishing.
            result = chat_service.result_from_completion(
                request,
                completion,
                enabled_tools,
                used_files,
                chat_service.completion_token_usage(completion_request, completion),
            )
            yield _stream_line({"type": "final", "result": result.model_dump(mode="json")})
        # Headers are already sent, so failures must be events inside this stream.
        except ProviderError as error:
            yield _stream_line({
                "type": "error",
                "message": str(error),
                "statusCode": error.status_code,
                "errorKind": "http",
                "errorCode": error.error_code,
            })
        except BackendApiError as error:
            yield _stream_line({
                "type": "error",
                "message": error.message,
                "statusCode": error.status_code,
                "errorKind": "http",
                "errorCode": error.error_code,
            })
        except Exception:
            logger.exception("Streamed provider request failed unexpectedly")
            yield _stream_line({
                "type": "error",
                "message": "The DevMate backend could not complete the streamed request.",
                "statusCode": 500,
                "errorKind": "http",
                "errorCode": "internal_error",
            })

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
