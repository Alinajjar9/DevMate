from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Request

from .chat_service import ChatService
from .providers import ChatProvider


BackendTokenProvider = Callable[[], str | None]


@dataclass(frozen=True, slots=True)
class BackendDependencies:
    chat_provider: ChatProvider
    chat_service: ChatService
    backend_token_provider: BackendTokenProvider


def backend_dependencies(request: Request) -> BackendDependencies:
    dependencies = getattr(request.app.state, "devmate_dependencies", None)
    if not isinstance(dependencies, BackendDependencies):
        raise RuntimeError("DevMate backend dependencies are not configured.")
    return dependencies


def get_chat_provider(request: Request) -> ChatProvider:
    return backend_dependencies(request).chat_provider


def get_chat_service(request: Request) -> ChatService:
    return backend_dependencies(request).chat_service
