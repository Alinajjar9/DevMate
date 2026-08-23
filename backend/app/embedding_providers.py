from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable


EmbeddingProviderName = Literal["ollama", "openai-compatible"]
EMBEDDING_PROVIDER_NAMES: tuple[EmbeddingProviderName, ...] = (
    "ollama",
    "openai-compatible",
)
MAX_EMBEDDING_PROFILE_ID_CHARACTERS = 120
MAX_EMBEDDING_MODEL_CHARACTERS = 120
MAX_EMBEDDING_DIMENSIONS = 16_384
MAX_EMBEDDING_BATCH_SIZE = 64
MAX_EMBEDDING_READ_BATCH_SIZE = 1_000
MAX_EMBEDDING_INPUT_CHARACTERS = 20_000
MAX_EMBEDDING_TOTAL_INPUT_CHARACTERS = 256_000
MAX_EMBEDDING_BASE_URL_CHARACTERS = 2_048
MAX_EMBEDDING_API_KEY_CHARACTERS = 8_192
MAX_EMBEDDING_INDEX_BATCHES_PER_RUN = 16


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
