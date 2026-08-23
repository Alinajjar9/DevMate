from __future__ import annotations

import math
import re
import sqlite3
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath

from .embedding_providers import (
    EMBEDDING_PROVIDER_NAMES,
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_MODEL_CHARACTERS,
    MAX_EMBEDDING_PROFILE_ID_CHARACTERS,
    MAX_EMBEDDING_READ_BATCH_SIZE,
    EmbeddingProviderName,
)
from .knowledge_contracts import (
    MAX_CHUNK_STABLE_ID_CHARACTERS,
    MAX_CONTENT_HASH_CHARACTERS,
    MAX_RELATIVE_PATH_CHARACTERS,
    MAX_SQLITE_INTEGER,
    MAX_WORKSPACE_KEY_CHARACTERS,
)
from .knowledge_repository import (
    KnowledgeRepositoryError,
    KnowledgeRepositoryNotFoundError,
    KnowledgeRepositoryValidationError,
)
from .knowledge_store import KnowledgeStore


_PROFILE_ID_PATTERN = re.compile(
    rf"^[A-Za-z0-9][A-Za-z0-9_-]{{0,{MAX_EMBEDDING_PROFILE_ID_CHARACTERS - 1}}}$"
)
_NORMALIZED_VECTOR_TOLERANCE = 1e-5


@dataclass(frozen=True, slots=True)
class EmbeddingConfiguration:
    profile_id: str
    provider: EmbeddingProviderName
    model: str
    dimensions: int
    vector_version: int


@dataclass(frozen=True, slots=True)
class EmbeddingChunkRecord:
    chunk_id: int
    relative_path: str
    language_id: str
    stable_id: str
    ordinal: int
    start_line: int
    end_line: int
    content: str
    content_hash: str


@dataclass(frozen=True, slots=True)
class ChunkEmbeddingWrite:
    relative_path: str
    stable_id: str
    content_hash: str
    vector: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class StoredEmbeddingRecord:
    chunk_id: int
    relative_path: str
    language_id: str
    stable_id: str
    ordinal: int
    start_line: int
    end_line: int
    content: str
    content_hash: str
    vector: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class EmbeddingWriteResult:
    stored_embeddings: int


class EmbeddingRepository:
    """Stores one active, workspace-isolated embedding configuration."""

    def __init__(self, store: KnowledgeStore) -> None:
        self._store = store

    def activate_configuration(
        self,
        workspace_key: str,
        configuration: EmbeddingConfiguration,
    ) -> int:
        validated_key = _workspace_key(workspace_key)
        validated_configuration = _validated_configuration(configuration)
        try:
            with self._store.transaction() as connection:
                workspace_id = self._workspace_id(connection, validated_key)
                cursor = connection.execute(
                    """
                    DELETE FROM embeddings
                    WHERE chunk_id IN (
                        SELECT chunks.id
                        FROM chunks
                        JOIN files ON files.id = chunks.file_id
                        WHERE files.workspace_id = ?
                    )
                    AND NOT (
                        profile_id = ?
                        AND provider = ?
                        AND model = ?
                        AND dimensions = ?
                        AND vector_version = ?
                    )
                    """,
                    (
                        workspace_id,
                        validated_configuration.profile_id,
                        validated_configuration.provider,
                        validated_configuration.model,
                        validated_configuration.dimensions,
                        validated_configuration.vector_version,
                    ),
                )
                connection.execute(
                    """
                    UPDATE index_metadata
                    SET embedding_profile_id = ?,
                        embedding_model = ?,
                        embedding_dimensions = ?,
                        vector_version = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE workspace_id = ?
                    """,
                    (
                        validated_configuration.profile_id,
                        validated_configuration.model,
                        validated_configuration.dimensions,
                        validated_configuration.vector_version,
                        workspace_id,
                    ),
                )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError(
                "The embedding configuration could not be activated."
            ) from error
        return max(cursor.rowcount, 0)

    def invalidate(self, workspace_key: str) -> int:
        validated_key = _workspace_key(workspace_key)
        try:
            with self._store.transaction() as connection:
                workspace_id = self._workspace_id(connection, validated_key)
                cursor = connection.execute(
                    """
                    DELETE FROM embeddings
                    WHERE chunk_id IN (
                        SELECT chunks.id
                        FROM chunks
                        JOIN files ON files.id = chunks.file_id
                        WHERE files.workspace_id = ?
                    )
                    """,
                    (workspace_id,),
                )
                connection.execute(
                    """
                    UPDATE index_metadata
                    SET embedding_profile_id = NULL,
                        embedding_model = NULL,
                        embedding_dimensions = NULL,
                        vector_version = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE workspace_id = ?
                    """,
                    (workspace_id,),
                )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError(
                "The workspace embeddings could not be invalidated."
            ) from error
        return max(cursor.rowcount, 0)

    def chunks_missing_embeddings(
        self,
        workspace_key: str,
        configuration: EmbeddingConfiguration,
        *,
        limit: int,
    ) -> tuple[EmbeddingChunkRecord, ...]:
        validated_key = _workspace_key(workspace_key)
        validated_configuration = _validated_configuration(configuration)
        validated_limit = _bounded_limit(
            limit,
            MAX_EMBEDDING_BATCH_SIZE,
            "embedding chunk",
        )
        try:
            connection = self._store.connection
            workspace_id = self._workspace_id(connection, validated_key)
            self._require_active_configuration(
                connection,
                workspace_id,
                validated_configuration,
            )
            rows = connection.execute(
                """
                SELECT
                    chunks.id AS chunk_id,
                    files.relative_path,
                    files.language_id,
                    chunks.stable_id,
                    chunks.ordinal,
                    chunks.start_line,
                    chunks.end_line,
                    chunks.content,
                    chunks.content_hash
                FROM chunks
                JOIN files ON files.id = chunks.file_id
                LEFT JOIN embeddings ON
                    embeddings.chunk_id = chunks.id
                    AND embeddings.profile_id = ?
                    AND embeddings.provider = ?
                    AND embeddings.model = ?
                    AND embeddings.dimensions = ?
                    AND embeddings.vector_version = ?
                WHERE files.workspace_id = ? AND embeddings.id IS NULL
                ORDER BY
                    files.relative_path COLLATE NOCASE,
                    files.relative_path,
                    chunks.ordinal
                LIMIT ?
                """,
                (
                    validated_configuration.profile_id,
                    validated_configuration.provider,
                    validated_configuration.model,
                    validated_configuration.dimensions,
                    validated_configuration.vector_version,
                    workspace_id,
                    validated_limit,
                ),
            ).fetchall()
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError(
                "Pending embedding chunks could not be loaded."
            ) from error
        return tuple(_chunk_record(row) for row in rows)

    def store_embeddings(
        self,
        workspace_key: str,
        configuration: EmbeddingConfiguration,
        writes: Sequence[ChunkEmbeddingWrite],
    ) -> EmbeddingWriteResult:
        validated_key = _workspace_key(workspace_key)
        validated_configuration = _validated_configuration(configuration)
        if not 1 <= len(writes) <= MAX_EMBEDDING_BATCH_SIZE:
            raise KnowledgeRepositoryValidationError(
                "The embedding write batch is empty or too large."
            )
        validated_writes = tuple(
            _validated_write(write, validated_configuration.dimensions)
            for write in writes
        )
        targets = [
            (write.relative_path, write.stable_id)
            for write, _vector in validated_writes
        ]
        if len(set(targets)) != len(targets):
            raise KnowledgeRepositoryValidationError(
                "Embedding write targets must be unique."
            )

        try:
            with self._store.transaction() as connection:
                workspace_id = self._workspace_id(connection, validated_key)
                self._require_active_configuration(
                    connection,
                    workspace_id,
                    validated_configuration,
                )
                for write, vector_blob in validated_writes:
                    row = connection.execute(
                        """
                        SELECT chunks.id
                        FROM chunks
                        JOIN files ON files.id = chunks.file_id
                        WHERE files.workspace_id = ?
                            AND files.relative_path = ?
                            AND chunks.stable_id = ?
                            AND chunks.content_hash = ?
                        """,
                        (
                            workspace_id,
                            write.relative_path,
                            write.stable_id,
                            write.content_hash,
                        ),
                    ).fetchone()
                    if row is None:
                        raise KnowledgeRepositoryNotFoundError(
                            "An embedding target chunk is missing or stale."
                        )
                    connection.execute(
                        """
                        INSERT INTO embeddings(
                            chunk_id,
                            profile_id,
                            provider,
                            model,
                            dimensions,
                            vector_version,
                            normalized,
                            vector
                        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                        ON CONFLICT(
                            chunk_id,
                            profile_id,
                            model,
                            dimensions,
                            vector_version
                        ) DO UPDATE SET
                            provider = excluded.provider,
                            normalized = 1,
                            vector = excluded.vector,
                            created_at = CURRENT_TIMESTAMP
                        """,
                        (
                            int(row["id"]),
                            validated_configuration.profile_id,
                            validated_configuration.provider,
                            validated_configuration.model,
                            validated_configuration.dimensions,
                            validated_configuration.vector_version,
                            vector_blob,
                        ),
                    )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError(
                "The embedding batch could not be stored."
            ) from error
        return EmbeddingWriteResult(stored_embeddings=len(validated_writes))

    def load_embeddings(
        self,
        workspace_key: str,
        configuration: EmbeddingConfiguration,
        *,
        after_chunk_id: int = 0,
        limit: int = MAX_EMBEDDING_READ_BATCH_SIZE,
    ) -> tuple[StoredEmbeddingRecord, ...]:
        validated_key = _workspace_key(workspace_key)
        validated_configuration = _validated_configuration(configuration)
        validated_cursor = _nonnegative_integer(after_chunk_id, "embedding cursor")
        validated_limit = _bounded_limit(
            limit,
            MAX_EMBEDDING_READ_BATCH_SIZE,
            "embedding read",
        )
        try:
            connection = self._store.connection
            workspace_id = self._workspace_id(connection, validated_key)
            self._require_active_configuration(
                connection,
                workspace_id,
                validated_configuration,
            )
            rows = connection.execute(
                """
                SELECT
                    chunks.id AS chunk_id,
                    files.relative_path,
                    files.language_id,
                    chunks.stable_id,
                    chunks.ordinal,
                    chunks.start_line,
                    chunks.end_line,
                    chunks.content,
                    chunks.content_hash,
                    embeddings.vector
                FROM embeddings
                JOIN chunks ON chunks.id = embeddings.chunk_id
                JOIN files ON files.id = chunks.file_id
                WHERE files.workspace_id = ?
                    AND chunks.id > ?
                    AND embeddings.profile_id = ?
                    AND embeddings.provider = ?
                    AND embeddings.model = ?
                    AND embeddings.dimensions = ?
                    AND embeddings.vector_version = ?
                    AND embeddings.normalized = 1
                ORDER BY chunks.id
                LIMIT ?
                """,
                (
                    workspace_id,
                    validated_cursor,
                    validated_configuration.profile_id,
                    validated_configuration.provider,
                    validated_configuration.model,
                    validated_configuration.dimensions,
                    validated_configuration.vector_version,
                    validated_limit,
                ),
            ).fetchall()
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError(
                "Stored embeddings could not be loaded."
            ) from error

        records: list[StoredEmbeddingRecord] = []
        for row in rows:
            chunk = _chunk_record(row)
            records.append(StoredEmbeddingRecord(
                chunk_id=chunk.chunk_id,
                relative_path=chunk.relative_path,
                language_id=chunk.language_id,
                stable_id=chunk.stable_id,
                ordinal=chunk.ordinal,
                start_line=chunk.start_line,
                end_line=chunk.end_line,
                content=chunk.content,
                content_hash=chunk.content_hash,
                vector=_decode_vector(
                    row["vector"],
                    validated_configuration.dimensions,
                ),
            ))
        return tuple(records)

    @staticmethod
    def _workspace_id(connection: sqlite3.Connection, workspace_key: str) -> int:
        row = connection.execute(
            "SELECT id FROM workspaces WHERE workspace_key = ?",
            (workspace_key,),
        ).fetchone()
        if row is None:
            raise KnowledgeRepositoryNotFoundError(
                "The workspace index does not exist."
            )
        return int(row["id"])

    @staticmethod
    def _require_active_configuration(
        connection: sqlite3.Connection,
        workspace_id: int,
        configuration: EmbeddingConfiguration,
    ) -> None:
        row = connection.execute(
            """
            SELECT
                embedding_profile_id,
                embedding_model,
                embedding_dimensions,
                vector_version
            FROM index_metadata
            WHERE workspace_id = ?
            """,
            (workspace_id,),
        ).fetchone()
        if row is None or (
            row["embedding_profile_id"] != configuration.profile_id
            or row["embedding_model"] != configuration.model
            or row["embedding_dimensions"] != configuration.dimensions
            or row["vector_version"] != configuration.vector_version
        ):
            raise KnowledgeRepositoryValidationError(
                "The embedding configuration is not active for this workspace."
            )
        stale_row = connection.execute(
            """
            SELECT embeddings.id
            FROM embeddings
            JOIN chunks ON chunks.id = embeddings.chunk_id
            JOIN files ON files.id = chunks.file_id
            WHERE files.workspace_id = ?
                AND NOT (
                    embeddings.profile_id = ?
                    AND embeddings.provider = ?
                    AND embeddings.model = ?
                    AND embeddings.dimensions = ?
                    AND embeddings.vector_version = ?
                )
            LIMIT 1
            """,
            (
                workspace_id,
                configuration.profile_id,
                configuration.provider,
                configuration.model,
                configuration.dimensions,
                configuration.vector_version,
            ),
        ).fetchone()
        if stale_row is not None:
            raise KnowledgeRepositoryValidationError(
                "The embedding configuration must be activated before use."
            )


def _validated_configuration(value: object) -> EmbeddingConfiguration:
    if not isinstance(value, EmbeddingConfiguration):
        raise KnowledgeRepositoryValidationError(
            "The embedding configuration is invalid."
        )
    if not _PROFILE_ID_PATTERN.fullmatch(value.profile_id):
        raise KnowledgeRepositoryValidationError(
            "The embedding profile identifier is invalid."
        )
    if value.provider not in EMBEDDING_PROVIDER_NAMES:
        raise KnowledgeRepositoryValidationError(
            "The embedding provider is invalid."
        )
    model = _bounded_text(
        value.model,
        "embedding model",
        MAX_EMBEDDING_MODEL_CHARACTERS,
    )
    dimensions = _positive_integer(value.dimensions, "embedding dimensions")
    if dimensions > MAX_EMBEDDING_DIMENSIONS:
        raise KnowledgeRepositoryValidationError(
            "The embedding dimensions are too large."
        )
    return EmbeddingConfiguration(
        profile_id=value.profile_id,
        provider=value.provider,
        model=model,
        dimensions=dimensions,
        vector_version=_positive_integer(value.vector_version, "vector version"),
    )


def _validated_write(
    value: object,
    dimensions: int,
) -> tuple[ChunkEmbeddingWrite, bytes]:
    if not isinstance(value, ChunkEmbeddingWrite):
        raise KnowledgeRepositoryValidationError("The embedding write is invalid.")
    vector_blob = _encode_normalized_vector(value.vector, dimensions)
    write = ChunkEmbeddingWrite(
        relative_path=_relative_path(value.relative_path),
        stable_id=_bounded_text(
            value.stable_id,
            "chunk stable identifier",
            MAX_CHUNK_STABLE_ID_CHARACTERS,
        ),
        content_hash=_bounded_text(
            value.content_hash,
            "chunk content hash",
            MAX_CONTENT_HASH_CHARACTERS,
        ),
        vector=tuple(float(component) for component in value.vector),
    )
    return write, vector_blob


def _encode_normalized_vector(value: object, dimensions: int) -> bytes:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes, bytearray))
        or len(value) != dimensions
    ):
        raise KnowledgeRepositoryValidationError(
            "The embedding vector dimensions are invalid."
        )
    vector: list[float] = []
    for component in value:
        if (
            not isinstance(component, (int, float))
            or isinstance(component, bool)
        ):
            raise KnowledgeRepositoryValidationError(
                "The embedding vector contains an invalid value."
            )
        numeric_component = float(component)
        if not math.isfinite(numeric_component):
            raise KnowledgeRepositoryValidationError(
                "The embedding vector contains an invalid value."
            )
        vector.append(numeric_component)
    norm = math.hypot(*vector)
    if not math.isclose(
        norm,
        1.0,
        rel_tol=_NORMALIZED_VECTOR_TOLERANCE,
        abs_tol=_NORMALIZED_VECTOR_TOLERANCE,
    ):
        raise KnowledgeRepositoryValidationError(
            "The embedding vector must be normalized."
        )
    try:
        encoded = struct.pack(f"<{dimensions}f", *vector)
    except (OverflowError, struct.error) as error:
        raise KnowledgeRepositoryValidationError(
            "The embedding vector cannot be encoded as float32."
        ) from error
    _decode_vector(encoded, dimensions)
    return encoded


def _decode_vector(value: object, dimensions: int) -> tuple[float, ...]:
    if not isinstance(value, bytes) or len(value) != dimensions * 4:
        raise KnowledgeRepositoryError("A stored embedding vector is invalid.")
    try:
        vector = tuple(float(component) for component in struct.unpack(
            f"<{dimensions}f",
            value,
        ))
    except struct.error as error:
        raise KnowledgeRepositoryError(
            "A stored embedding vector could not be decoded."
        ) from error
    if not all(math.isfinite(component) for component in vector) or not math.isclose(
        math.hypot(*vector),
        1.0,
        rel_tol=_NORMALIZED_VECTOR_TOLERANCE,
        abs_tol=_NORMALIZED_VECTOR_TOLERANCE,
    ):
        raise KnowledgeRepositoryError(
            "A stored embedding vector is not safely normalized."
        )
    return vector


def _chunk_record(row: sqlite3.Row) -> EmbeddingChunkRecord:
    return EmbeddingChunkRecord(
        chunk_id=int(row["chunk_id"]),
        relative_path=str(row["relative_path"]),
        language_id=str(row["language_id"]),
        stable_id=str(row["stable_id"]),
        ordinal=int(row["ordinal"]),
        start_line=int(row["start_line"]),
        end_line=int(row["end_line"]),
        content=str(row["content"]),
        content_hash=str(row["content_hash"]),
    )


def _workspace_key(value: object) -> str:
    return _bounded_text(value, "workspace key", MAX_WORKSPACE_KEY_CHARACTERS)


def _bounded_text(value: object, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 for character in value)
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value


def _relative_path(value: object) -> str:
    relative_path = _bounded_text(value, "relative path", MAX_RELATIVE_PATH_CHARACTERS)
    normalized = relative_path.replace("\\", "/")
    parsed = PurePosixPath(normalized)
    if (
        parsed.is_absolute()
        or normalized.startswith("//")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in ("", ".", "..") for part in parsed.parts)
    ):
        raise KnowledgeRepositoryValidationError("The relative path is invalid.")
    return parsed.as_posix()


def _positive_integer(value: object, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= MAX_SQLITE_INTEGER
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value


def _nonnegative_integer(value: object, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 0 <= value <= MAX_SQLITE_INTEGER
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value


def _bounded_limit(value: object, maximum: int, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= maximum
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} limit is invalid.")
    return value
