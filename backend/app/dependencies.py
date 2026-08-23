from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Request

from .chat_service import ChatService
from .embedding_index_service import EmbeddingIndexService
from .errors import BackendApiError
from .knowledge_repository import KnowledgeRepository
from .knowledge_store import KnowledgeStore
from .providers import ChatProvider
from .semantic_search_service import SemanticSearchService


BackendTokenProvider = Callable[[], str | None]


@dataclass(frozen=True, slots=True)
class BackendDependencies:
    chat_provider: ChatProvider
    chat_service: ChatService
    backend_token_provider: BackendTokenProvider
    knowledge_store: KnowledgeStore | None
    knowledge_repository: KnowledgeRepository | None
    embedding_index_service: EmbeddingIndexService | None
    semantic_search_service: SemanticSearchService | None


def backend_dependencies(request: Request) -> BackendDependencies:
    dependencies = getattr(request.app.state, "devmate_dependencies", None)
    if not isinstance(dependencies, BackendDependencies):
        raise RuntimeError("DevMate backend dependencies are not configured.")
    return dependencies


def get_chat_provider(request: Request) -> ChatProvider:
    return backend_dependencies(request).chat_provider


def get_chat_service(request: Request) -> ChatService:
    return backend_dependencies(request).chat_service


def get_knowledge_repository(request: Request) -> KnowledgeRepository:
    repository = backend_dependencies(request).knowledge_repository
    if repository is None:
        raise BackendApiError(
            503,
            "knowledge_store_unavailable",
            "The local DevMate knowledge store is unavailable.",
        )
    return repository


def get_embedding_index_service(request: Request) -> EmbeddingIndexService:
    service = backend_dependencies(request).embedding_index_service
    if service is None:
        raise BackendApiError(
            503,
            "knowledge_store_unavailable",
            "The local DevMate knowledge store is unavailable.",
        )
    return service


def get_semantic_search_service(request: Request) -> SemanticSearchService:
    service = backend_dependencies(request).semantic_search_service
    if service is None:
        raise BackendApiError(
            503,
            "knowledge_store_unavailable",
            "The local DevMate knowledge store is unavailable.",
        )
    return service
