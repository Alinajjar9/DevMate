# Generate missing embeddings in bounded batches that can resume later.
# The source index remains usable even when an embedding provider is unavailable.

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from ..providers.embedding_providers import (
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
    MAX_EMBEDDING_MODEL_CHARACTERS,
    MAX_EMBEDDING_TOTAL_INPUT_CHARACTERS,
    EmbeddingBatch,
    EmbeddingProvider,
    EmbeddingProfile,
    EmbeddingRequest,
)
from .embedding_repository import (
    ChunkEmbeddingWrite,
    EmbeddingChunkRecord,
    EmbeddingConfiguration,
    EmbeddingRepository,
)


class EmbeddingIndexError(RuntimeError):
    """Raised when an embedding provider breaks the indexing contract."""


@dataclass(frozen=True, slots=True)
class EmbeddingIndexResult:
    configuration: EmbeddingConfiguration | None
    embedded_chunks: int
    processed_batches: int
    complete: bool


class EmbeddingIndexService:
    """Generates missing code embeddings in bounded, resumable batches."""

    def __init__(
        self,
        provider: EmbeddingProvider,
        repository: EmbeddingRepository,
    ) -> None:
        self._provider = provider
        self._repository = repository

    async def synchronize_workspace(
        self,
        workspace_key: str,
        profile: EmbeddingProfile,
        *,
        batch_size: int = MAX_EMBEDDING_BATCH_SIZE,
        max_batches: int = MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
    ) -> EmbeddingIndexResult:
        if not isinstance(profile, EmbeddingProfile):
            raise EmbeddingIndexError("The embedding index profile is invalid.")
        if (
            not isinstance(batch_size, int)
            or isinstance(batch_size, bool)
            or not 1 <= batch_size <= MAX_EMBEDDING_BATCH_SIZE
        ):
            raise EmbeddingIndexError("The embedding index batch size is invalid.")
        if (
            not isinstance(max_batches, int)
            or isinstance(max_batches, bool)
            or not 1 <= max_batches <= MAX_EMBEDDING_INDEX_BATCHES_PER_RUN
        ):
            raise EmbeddingIndexError("The embedding index batch limit is invalid.")

        configuration = self._repository.active_configuration(
            workspace_key,
            profile_id=profile.profile_id,
            provider=profile.provider,
            model=profile.model,
            vector_version=profile.vector_version,
        )
        embedded_chunks = 0
        processed_batches = 0

        # Bound each call so the extension can cancel or resume between batches.
        while processed_batches < max_batches:
            pending = self._pending_chunks(
                workspace_key,
                configuration,
                batch_size,
            )
            if not pending:
                if configuration is None:
                    self._repository.invalidate(workspace_key)
                return EmbeddingIndexResult(
                    configuration=configuration,
                    embedded_chunks=embedded_chunks,
                    processed_batches=processed_batches,
                    complete=True,
                )

            batch = await self._provider.embed(EmbeddingRequest(
                provider=profile.provider,
                model=profile.model,
                base_url=profile.base_url,
                api_key=profile.api_key,
                inputs=tuple(chunk.content for chunk in pending),
                remote_allowed=profile.remote_allowed,
            ))
            self._validate_batch(batch, len(pending))

            next_configuration = EmbeddingConfiguration(
                profile_id=profile.profile_id,
                provider=profile.provider,
                model=profile.model,
                dimensions=batch.dimensions,
                vector_version=profile.vector_version,
            )
            # Dimensions come from the response. A changed configuration invalidates old vectors.
            if configuration != next_configuration:
                self._repository.activate_configuration(
                    workspace_key,
                    next_configuration,
                )
                configuration = next_configuration

            # Storage checks hashes again because source chunks may have changed during embedding.
            result = self._repository.store_embeddings(
                workspace_key,
                configuration,
                tuple(
                    ChunkEmbeddingWrite(
                        relative_path=chunk.relative_path,
                        stable_id=chunk.stable_id,
                        content_hash=chunk.content_hash,
                        vector=vector,
                    )
                    for chunk, vector in zip(pending, batch.vectors, strict=True)
                ),
            )
            embedded_chunks += result.stored_embeddings
            processed_batches += 1

        # Probe one remaining row rather than count the whole index just to report completion.
        remaining = self._repository.chunks_missing_embeddings(
            workspace_key,
            configuration,
            limit=1,
        )
        return EmbeddingIndexResult(
            configuration=configuration,
            embedded_chunks=embedded_chunks,
            processed_batches=processed_batches,
            complete=not remaining,
        )

    def _pending_chunks(
        self,
        workspace_key: str,
        configuration: EmbeddingConfiguration | None,
        batch_size: int,
    ) -> tuple[EmbeddingChunkRecord, ...]:
        candidates = (
            self._repository.source_chunks(workspace_key, limit=batch_size)
            if configuration is None
            else self._repository.chunks_missing_embeddings(
                workspace_key,
                configuration,
                limit=batch_size,
            )
        )
        total_characters = 0
        selected: list[EmbeddingChunkRecord] = []
        for chunk in candidates:
            next_total = total_characters + len(chunk.content)
            if next_total > MAX_EMBEDDING_TOTAL_INPUT_CHARACTERS:
                break
            selected.append(chunk)
            total_characters = next_total
        return tuple(selected)

    @staticmethod
    def _validate_batch(batch: object, expected_count: int) -> None:
        if not isinstance(batch, EmbeddingBatch):
            raise EmbeddingIndexError(
                "The embedding provider returned an invalid batch."
            )
        if (
            not isinstance(batch.model, str)
            or not batch.model.strip()
            or len(batch.model) > MAX_EMBEDDING_MODEL_CHARACTERS
            or not isinstance(batch.dimensions, int)
            or isinstance(batch.dimensions, bool)
            or not 1 <= batch.dimensions <= MAX_EMBEDDING_DIMENSIONS
            or not isinstance(batch.vectors, Sequence)
            or isinstance(batch.vectors, (str, bytes, bytearray))
        ):
            raise EmbeddingIndexError(
                "The embedding provider returned an invalid batch."
            )
        if len(batch.vectors) != expected_count:
            raise EmbeddingIndexError(
                "The embedding provider returned the wrong number of vectors."
            )
        for vector in batch.vectors:
            if (
                not isinstance(vector, Sequence)
                or isinstance(vector, (str, bytes, bytearray))
                or len(vector) != batch.dimensions
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
                raise EmbeddingIndexError(
                    "The embedding provider returned an invalid vector."
                )
