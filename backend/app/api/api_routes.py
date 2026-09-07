# Expose health, chat completion, and streaming endpoints.
# Translate service results into HTTP responses without putting provider logic in the routes.

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
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
from ..providers.chat_provider import ChatCompletion, ChatProvider, stream_chat_completion
from ..providers.provider_network import ProviderError
from ..chat.text_tool_calls import classify_text_tool_call_prefix


logger = logging.getLogger(__name__)
api_router = APIRouter()


def _provider_api_error(error: ProviderError) -> BackendApiError:
    return BackendApiError(error.status_code, error.error_code, str(error))


def _stream_line(value: dict[str, object]) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"


@dataclass
class _AnswerPreview:
    """Hold possible tool markup until it is safe to show as ordinary answer text."""

    mode: Literal["pending", "answer", "tool"] = "pending"
    buffer: str = ""

    def push(self, text: str) -> str | None:
        if self.mode == "answer":
            return text
        if self.mode == "tool":
            return None
        self.buffer += text
        self.mode = classify_text_tool_call_prefix(self.buffer)
        if self.mode == "pending":
            return None
        visible = self.buffer if self.mode == "answer" else None
        self.buffer = ""
        return visible

    def finish(self, *, converted_text_tool: bool) -> str | None:
        if self.mode == "tool" or (self.mode == "pending" and converted_text_tool):
            return None
        return self.buffer or None

    def defer_completed_text(self, text: str) -> None:
        self.buffer = text
        self.mode = classify_text_tool_call_prefix(text)


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
        completion = await chat_provider.complete(completion_request)
    except ProviderError as error:
        raise _provider_api_error(error) from error

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
        preview = _AnswerPreview()
        try:
            async for event in stream_chat_completion(chat_provider, completion_request):
                if event.kind == "content" and event.text:
                    visible_text = preview.push(event.text)
                    if visible_text is not None:
                        yield _stream_line({"type": "delta", "text": visible_text})
                    elif preview.mode == "tool" and not tool_announced:
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
                    if event.deferred_preview:
                        preview.defer_completed_text(event.deferred_preview)

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
            remaining_text = preview.finish(converted_text_tool=converted_text_tool)
            if remaining_text is not None:
                yield _stream_line({"type": "delta", "text": remaining_text})
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
