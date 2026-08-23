from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable


EmbeddingProviderName = Literal["ollama", "openai-compatible"]


@dataclass(frozen=True, slots=True)
class EmbeddingRequest:
    provider: EmbeddingProviderName
    model: str
    base_url: str
    api_key: str | None
    inputs: tuple[str, ...]
    remote_allowed: bool = False


@dataclass(frozen=True, slots=True)
class EmbeddingBatch:
    model: str
    dimensions: int
    vectors: tuple[tuple[float, ...], ...]


@runtime_checkable
class EmbeddingProvider(Protocol):
    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch: ...
