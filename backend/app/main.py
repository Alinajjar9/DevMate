import logging
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api_models import (
    DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE,
    DEVMATE_BACKEND_TOKEN_HEADER,
    DEVMATE_BACKEND_VERSION,
    MAX_BACKEND_TOKEN_CHARACTERS,
    MIN_BACKEND_TOKEN_CHARACTERS,
    BackendErrorCode,
    BackendErrorResult,
    ValidationIssue,
)
from .api_routes import api_router
from .chat_service import ChatService
from .dependencies import (
    BackendDependencies,
    BackendTokenProvider,
    backend_dependencies,
)
from .errors import BackendApiError
from .embedding_clients import HttpEmbeddingProvider
from .embedding_index_service import EmbeddingIndexService
from .embedding_repository import EmbeddingRepository
from .knowledge_contracts import DEVMATE_KNOWLEDGE_INDEX_API_VERSION
from .knowledge_repository import KnowledgeRepository
from .knowledge_routes import knowledge_router
from .knowledge_store import KnowledgeStore, knowledge_store_path_from_environment
from .providers import ChatProvider, OpenAICompatibleProvider
from .tool_catalog import AGENT_TOOL_DEFINITIONS


logger = logging.getLogger(__name__)


_authenticated_backend_paths = frozenset(("/health", "/ask", "/ask/stream"))
_authenticated_backend_prefixes = (
    f"/index/v{DEVMATE_KNOWLEDGE_INDEX_API_VERSION}/",
)


def _environment_backend_token() -> str | None:
    return os.environ.get(DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE)


def _environment_knowledge_store() -> KnowledgeStore | None:
    database_path = knowledge_store_path_from_environment()
    return KnowledgeStore(database_path) if database_path is not None else None


@asynccontextmanager
async def backend_lifespan(application: FastAPI) -> AsyncIterator[None]:
    dependencies = getattr(application.state, "devmate_dependencies", None)
    if not isinstance(dependencies, BackendDependencies):
        raise RuntimeError("DevMate backend dependencies are not configured.")

    knowledge_store = dependencies.knowledge_store
    if knowledge_store is not None:
        knowledge_store.open()
    try:
        yield
    finally:
        if knowledge_store is not None:
            knowledge_store.close()


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


async def authenticate_backend_request(request: Request, call_next):
    requires_authentication = (
        request.url.path in _authenticated_backend_paths
        or request.url.path.startswith(_authenticated_backend_prefixes)
    )
    if not requires_authentication:
        return await call_next(request)

    expected_token = backend_dependencies(request).backend_token_provider()
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


def create_app(
    *,
    chat_provider: ChatProvider | None = None,
    chat_service: ChatService | None = None,
    backend_token_provider: BackendTokenProvider | None = None,
    knowledge_store: KnowledgeStore | None = None,
    knowledge_repository: KnowledgeRepository | None = None,
    embedding_index_service: EmbeddingIndexService | None = None,
) -> FastAPI:
    resolved_knowledge_store = (
        knowledge_store
        if knowledge_store is not None
        else _environment_knowledge_store()
    )
    resolved_knowledge_repository = knowledge_repository
    if resolved_knowledge_repository is None and resolved_knowledge_store is not None:
        resolved_knowledge_repository = KnowledgeRepository(resolved_knowledge_store)
    resolved_embedding_index_service = embedding_index_service
    if resolved_embedding_index_service is None and resolved_knowledge_store is not None:
        resolved_embedding_index_service = EmbeddingIndexService(
            HttpEmbeddingProvider(),
            EmbeddingRepository(resolved_knowledge_store),
        )
    application = FastAPI(
        title="DevMate Backend",
        version=DEVMATE_BACKEND_VERSION,
        lifespan=backend_lifespan,
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
        knowledge_store=resolved_knowledge_store,
        knowledge_repository=resolved_knowledge_repository,
        embedding_index_service=resolved_embedding_index_service,
    )
    application.middleware("http")(authenticate_backend_request)
    application.add_exception_handler(BackendApiError, backend_api_error)
    application.add_exception_handler(StarletteHTTPException, framework_http_error)
    application.add_exception_handler(RequestValidationError, request_validation_error)
    application.include_router(api_router)
    application.include_router(knowledge_router)
    return application


app = create_app()
