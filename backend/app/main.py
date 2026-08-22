import json
import logging
import os
import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api_models import (
    DEVMATE_BACKEND_CAPABILITIES,
    DEVMATE_BACKEND_PROTOCOL_VERSION,
    DEVMATE_BACKEND_SERVICE,
    DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE,
    DEVMATE_BACKEND_TOKEN_HEADER,
    DEVMATE_BACKEND_VERSION,
    MAX_BACKEND_TOKEN_CHARACTERS,
    MIN_BACKEND_TOKEN_CHARACTERS,
    AskRequest,
    AskResult,
    BackendErrorCode,
    BackendErrorResult,
    HealthData,
    HealthResult,
    ValidationIssue,
)
from .chat_service import ChatService
from .errors import BackendApiError
from .providers import (
    ChatCompletion,
    ChatProvider,
    OpenAICompatibleProvider,
    ProviderError,
)
from .text_tool_calls import (
    classify_text_tool_call_prefix,
)
from .tool_catalog import AGENT_TOOL_DEFINITIONS


logger = logging.getLogger(__name__)


BackendTokenProvider = Callable[[], str | None]


@dataclass(frozen=True, slots=True)
class BackendDependencies:
    chat_provider: ChatProvider
    chat_service: ChatService
    backend_token_provider: BackendTokenProvider


_api_router = APIRouter()
_authenticated_backend_paths = frozenset(("/health", "/ask", "/ask/stream"))


def _environment_backend_token() -> str | None:
    return os.environ.get(DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE)


def _backend_dependencies(request: Request) -> BackendDependencies:
    dependencies = getattr(request.app.state, "devmate_dependencies", None)
    if not isinstance(dependencies, BackendDependencies):
        raise RuntimeError("DevMate backend dependencies are not configured.")
    return dependencies


def get_chat_provider(request: Request) -> ChatProvider:
    return _backend_dependencies(request).chat_provider


def get_chat_service(request: Request) -> ChatService:
    return _backend_dependencies(request).chat_service


def _safe_error_message(value: object, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    normalized = " ".join(value.split())[:1_000]
    return normalized or fallback


def _backend_error_response(
    status_code: int,
    error_code: BackendErrorCode,
    message: str,
    issues: list[ValidationIssue] | None = None,
) -> JSONResponse:
    result = BackendErrorResult(
        status="error",
        errorCode=error_code,
        message=_safe_error_message(message, "The DevMate backend request failed."),
        issues=issues or [],
    )
    return JSONResponse(status_code=status_code, content=result.model_dump(mode="json"))


def _provider_api_error(error: ProviderError) -> BackendApiError:
    return BackendApiError(error.status_code, error.error_code, str(error))


async def authenticate_backend_request(request: Request, call_next):
    if request.url.path not in _authenticated_backend_paths:
        return await call_next(request)

    expected_token = _backend_dependencies(request).backend_token_provider()
    provided_token = request.headers.get(DEVMATE_BACKEND_TOKEN_HEADER)
    if (
        expected_token is None
        or provided_token is None
        or not expected_token.isascii()
        or not provided_token.isascii()
        or not MIN_BACKEND_TOKEN_CHARACTERS <= len(expected_token) <= MAX_BACKEND_TOKEN_CHARACTERS
        or not MIN_BACKEND_TOKEN_CHARACTERS <= len(provided_token) <= MAX_BACKEND_TOKEN_CHARACTERS
        or not secrets.compare_digest(provided_token, expected_token)
    ):
        return JSONResponse(
            status_code=401,
            content=BackendErrorResult(
                status="error",
                errorCode="backend_authentication_failed",
                message="DevMate backend authentication failed.",
            ).model_dump(mode="json"),
        )
    return await call_next(request)


async def backend_api_error(
    _request: Request,
    error: BackendApiError,
) -> JSONResponse:
    return _backend_error_response(
        error.status_code,
        error.error_code,
        error.message,
    )


async def framework_http_error(
    _request: Request,
    error: StarletteHTTPException,
) -> JSONResponse:
    error_code: BackendErrorCode = (
        "route_unavailable"
        if error.status_code in {404, 405}
        else "request_validation_failed"
        if 400 <= error.status_code < 500
        else "internal_error"
    )
    return _backend_error_response(
        error.status_code,
        error_code,
        _safe_error_message(error.detail, "The DevMate backend request failed."),
    )


async def request_validation_error(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    issues = [
        ValidationIssue(
            location=[part for part in item.get("loc", ()) if isinstance(part, (str, int))],
            message=str(item.get("msg", "Invalid value"))[:240],
            type=str(item.get("type", "value_error"))[:120],
        )
        for item in error.errors()[:8]
    ]
    summary = "; ".join(
        f"{'.'.join(str(part) for part in issue.location)}: {issue.message}"
        for issue in issues[:4]
    )
    logger.warning("Rejected %s request validation: %s", request.url.path, summary)
    return _backend_error_response(
        422,
        "request_validation_failed",
        "The DevMate request contains invalid fields.",
        issues,
    )


@_api_router.get("/health", response_model=HealthResult)
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


@_api_router.post("/ask", response_model=AskResult)
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


@_api_router.post("/ask/stream")
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
            result = chat_service.result_from_completion(
                request,
                completion,
                enabled_tools,
                used_files,
                chat_service.completion_token_usage(completion_request, completion),
            )
            yield _stream_line({"type": "final", "result": result.model_dump(mode="json")})
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


def create_app(
    *,
    chat_provider: ChatProvider | None = None,
    chat_service: ChatService | None = None,
    backend_token_provider: BackendTokenProvider | None = None,
) -> FastAPI:
    application = FastAPI(
        title="DevMate Backend",
        version=DEVMATE_BACKEND_VERSION,
    )
    application.state.devmate_dependencies = BackendDependencies(
        chat_provider=(
            chat_provider
            if chat_provider is not None
            else OpenAICompatibleProvider()
        ),
        chat_service=(
            chat_service
            if chat_service is not None
            else ChatService(AGENT_TOOL_DEFINITIONS)
        ),
        backend_token_provider=(
            backend_token_provider
            if backend_token_provider is not None
            else _environment_backend_token
        ),
    )
    application.middleware("http")(authenticate_backend_request)
    application.add_exception_handler(BackendApiError, backend_api_error)
    application.add_exception_handler(StarletteHTTPException, framework_http_error)
    application.add_exception_handler(RequestValidationError, request_validation_error)
    application.include_router(_api_router)
    return application


app = create_app()


def _stream_line(value: dict[str, object]) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"
