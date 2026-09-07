# Embed the query once, then rank cached source vectors by cosine similarity.
# Read vectors in pages and retain only the best requested matches.

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from ..providers.embedding_providers import (
    MAX_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_READ_BATCH_SIZE,
    EmbeddingBatch,
    EmbeddingProvider,
    EmbeddingProfile,
    EmbeddingRequest,
)
from .embedding_repository import (
    EmbeddingConfiguration,
    EmbeddingRepository,
    StoredEmbeddingRecord,
)
from .knowledge_contracts import (
    MAX_SEMANTIC_QUERY_CHARACTERS,
    MAX_SEMANTIC_RESULTS,
)


class SemanticSearchError(RuntimeError):
    """Raised when query-time embedding data breaks the retrieval contract."""


@dataclass(frozen=True, slots=True)
class SemanticSearchMatch:
    chunk_id: int
    relative_path: str
    language_id: str
    stable_id: str
    ordinal: int
    start_line: int
    end_line: int
    content: str
    content_hash: str
    score: float


@dataclass(frozen=True, slots=True)
class SemanticSearchResult:
    configuration: EmbeddingConfiguration | None
    matches: tuple[SemanticSearchMatch, ...]


class SemanticSearchService:
    """Embeds one query and exactly ranks the workspace's cached vectors."""

    def __init__(
        self,
        provider: EmbeddingProvider,
        repository: EmbeddingRepository,
        *,
        read_batch_size: int = MAX_EMBEDDING_READ_BATCH_SIZE,
    ) -> None:
        if (
            not isinstance(read_batch_size, int)
            or isinstance(read_batch_size, bool)
            or not 1 <= read_batch_size <= MAX_EMBEDDING_READ_BATCH_SIZE
        ):
            raise ValueError("The semantic embedding read batch size is invalid.")
        self._provider = provider
        self._repository = repository
        self._read_batch_size = read_batch_size

    async def search_workspace(
        self,
        workspace_key: str,
        query: str,
        profile: EmbeddingProfile,
        *,
        limit: int,
    ) -> SemanticSearchResult:
        if not isinstance(profile, EmbeddingProfile):
            raise SemanticSearchError("The semantic search profile is invalid.")
        if (
            not isinstance(query, str)
            or not query.strip()
            or len(query) > MAX_SEMANTIC_QUERY_CHARACTERS
            or "\0" in query
        ):
            raise SemanticSearchError("The semantic search query is invalid.")
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= MAX_SEMANTIC_RESULTS
        ):
            raise SemanticSearchError("The semantic search result limit is invalid.")

        configuration = self._repository.active_configuration(
            workspace_key,
            profile_id=profile.profile_id,
            provider=profile.provider,
            model=profile.model,
            vector_version=profile.vector_version,
        )
        # Without compatible stored vectors, a query embedding would be a needless provider call.
        if configuration is None:
            return SemanticSearchResult(configuration=None, matches=())

        batch = await self._provider.embed(EmbeddingRequest(
            provider=profile.provider,
            model=profile.model,
            base_url=profile.base_url,
            api_key=profile.api_key,
            inputs=(query,),
            remote_allowed=profile.remote_allowed,
        ))
        query_vector = self._query_vector(
            batch,
            configuration.dimensions,
            profile.model,
        )

        # Scan every page for exact ranking, but keep only the best matches after each page.
        best: list[SemanticSearchMatch] = []
        after_chunk_id = 0
        while True:
            stored = self._repository.load_embeddings(
                workspace_key,
                configuration,
                after_chunk_id=after_chunk_id,
                limit=self._read_batch_size,
            )
            if not stored:
                break
            best.extend(self._match(record, query_vector) for record in stored)
            best.sort(key=_match_sort_key)
            del best[limit:]
            after_chunk_id = stored[-1].chunk_id
            if len(stored) < self._read_batch_size:
                break

        return SemanticSearchResult(
            configuration=configuration,
            matches=tuple(best),
        )

    @staticmethod
    def _query_vector(
        batch: object,
        dimensions: int,
        expected_model: str,
    ) -> tuple[float, ...]:
        if (
            not isinstance(batch, EmbeddingBatch)
            or batch.model != expected_model
            or not isinstance(batch.dimensions, int)
            or isinstance(batch.dimensions, bool)
            or not 1 <= batch.dimensions <= MAX_EMBEDDING_DIMENSIONS
            or batch.dimensions != dimensions
            or not isinstance(batch.vectors, Sequence)
            or isinstance(batch.vectors, (str, bytes, bytearray))
            or len(batch.vectors) != 1
        ):
            raise SemanticSearchError(
                "The embedding provider returned an invalid semantic query vector."
            )
        vector = batch.vectors[0]
        if (
            not isinstance(vector, Sequence)
            or isinstance(vector, (str, bytes, bytearray))
            or len(vector) != dimensions
            or any(
                not isinstance(component, (int, float))
                or isinstance(component, bool)
                or not math.isfinite(float(component))
                for component in vector
            )
            or not math.isclose(
                math.hypot(*(float(component) for component in vector)),
                1.0,
                rel_tol=1e-5,
                abs_tol=1e-5,
            )
        ):
            raise SemanticSearchError(
                "The embedding provider returned an invalid semantic query vector."
            )
        return tuple(float(component) for component in vector)

    @staticmethod
    def _match(
        record: StoredEmbeddingRecord,
        query_vector: tuple[float, ...],
    ) -> SemanticSearchMatch:
        # Both vectors have length one, so their dot product equals cosine similarity.
        score = math.fsum(
            query_component * source_component
            for query_component, source_component in zip(
                query_vector,
                record.vector,
                strict=True,
            )
        )
        return SemanticSearchMatch(
            chunk_id=record.chunk_id,
            relative_path=record.relative_path,
            language_id=record.language_id,
            stable_id=record.stable_id,
            ordinal=record.ordinal,
            start_line=record.start_line,
            end_line=record.end_line,
            content=record.content,
            content_hash=record.content_hash,
            # Rounding can put a result just outside cosine's mathematical range.
            score=max(-1.0, min(1.0, score)),
        )


def _match_sort_key(match: SemanticSearchMatch) -> tuple[object, ...]:
    return (
        -match.score,
        match.relative_path.casefold(),
        match.relative_path,
        match.ordinal,
        match.chunk_id,
    )
