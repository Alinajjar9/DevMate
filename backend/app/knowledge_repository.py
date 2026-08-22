from __future__ import annotations

import re
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from .knowledge_store import KnowledgeStore


IndexState = Literal["empty", "indexing", "ready", "stale", "failed"]

MAX_WORKSPACE_KEY_CHARACTERS = 256
MAX_WORKSPACE_ROOT_CHARACTERS = 4_096
MAX_RELATIVE_PATH_CHARACTERS = 1_024
MAX_LANGUAGE_ID_CHARACTERS = 128
MAX_CONTENT_HASH_CHARACTERS = 256
MAX_CHUNK_STABLE_ID_CHARACTERS = 1_280
MAX_CHUNK_CHARACTERS = 20_000
MAX_CHUNKS_PER_FILE = 512
MAX_FILE_CHANGES_PER_BATCH = 500
MAX_LEXICAL_QUERY_CHARACTERS = 2_000
MAX_LEXICAL_QUERY_TERMS = 32
MAX_LEXICAL_RESULTS = 100
MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807

_INDEX_STATES: frozenset[str] = frozenset(("empty", "indexing", "ready", "stale", "failed"))
_SEARCH_TERM_PATTERN = re.compile(r"[^\W_]+(?:_[^\W_]+)*", re.UNICODE)


class KnowledgeRepositoryError(RuntimeError):
    """Raised when a knowledge-index repository operation cannot complete."""


class KnowledgeRepositoryValidationError(KnowledgeRepositoryError):
    """Raised when repository input violates the local index contract."""


class KnowledgeRepositoryNotFoundError(KnowledgeRepositoryError):
    """Raised when an operation targets an unknown workspace."""


@dataclass(frozen=True, slots=True)
class IndexedChunk:
    stable_id: str
    ordinal: int
    start_line: int
    end_line: int
    content: str
    content_hash: str
    chunking_version: int


@dataclass(frozen=True, slots=True)
class IndexedFile:
    relative_path: str
    language_id: str
    content_hash: str
    size_bytes: int
    modified_at: int
    chunks: tuple[IndexedChunk, ...]


@dataclass(frozen=True, slots=True)
class WorkspaceRecord:
    id: int
    workspace_key: str
    root_path: str


@dataclass(frozen=True, slots=True)
class FileFingerprint:
    relative_path: str
    content_hash: str
    size_bytes: int
    modified_at: int


@dataclass(frozen=True, slots=True)
class IndexMetadataRecord:
    workspace_key: str
    chunking_version: int
    index_state: IndexState
    last_full_scan_at: str | None


@dataclass(frozen=True, slots=True)
class IndexWriteResult:
    upserted_files: int
    deleted_files: int


@dataclass(frozen=True, slots=True)
class LexicalSearchResult:
    relative_path: str
    language_id: str
    stable_id: str
    ordinal: int
    start_line: int
    end_line: int
    content: str
    content_hash: str
    score: float


class KnowledgeRepository:
    """Provides transactional, workspace-isolated access to indexed source chunks."""

    def __init__(self, store: KnowledgeStore) -> None:
        self._store = store

    def register_workspace(
        self,
        workspace_key: str,
        root_path: str,
        *,
        chunking_version: int,
    ) -> WorkspaceRecord:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        validated_root = _absolute_root_path(root_path)
        validated_version = _positive_integer(chunking_version, "chunking version")
        try:
            with self._store.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO workspaces(workspace_key, root_path)
                    VALUES (?, ?)
                    ON CONFLICT(workspace_key) DO UPDATE SET
                        root_path = excluded.root_path,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (validated_key, validated_root),
                )
                row = connection.execute(
                    """
                    SELECT id, workspace_key, root_path
                    FROM workspaces
                    WHERE workspace_key = ?
                    """,
                    (validated_key,),
                ).fetchone()
                if row is None:
                    raise KnowledgeRepositoryError("The workspace could not be registered.")
                connection.execute(
                    """
                    INSERT INTO index_metadata(workspace_id, chunking_version)
                    VALUES (?, ?)
                    ON CONFLICT(workspace_id) DO UPDATE SET
                        index_state = 'stale',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE index_metadata.chunking_version <> excluded.chunking_version
                    """,
                    (row["id"], validated_version),
                )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError("The workspace could not be registered.") from error
        return WorkspaceRecord(
            id=int(row["id"]),
            workspace_key=str(row["workspace_key"]),
            root_path=str(row["root_path"]),
        )

    def file_fingerprints(self, workspace_key: str) -> tuple[FileFingerprint, ...]:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        rows = self._store.connection.execute(
            """
            SELECT files.relative_path, files.content_hash, files.size_bytes, files.modified_at
            FROM files
            JOIN workspaces ON workspaces.id = files.workspace_id
            WHERE workspaces.workspace_key = ?
            ORDER BY files.relative_path COLLATE NOCASE, files.relative_path
            """,
            (validated_key,),
        ).fetchall()
        return tuple(
            FileFingerprint(
                relative_path=str(row["relative_path"]),
                content_hash=str(row["content_hash"]),
                size_bytes=int(row["size_bytes"]),
                modified_at=int(row["modified_at"]),
            )
            for row in rows
        )

    def apply_file_changes(
        self,
        workspace_key: str,
        *,
        upserts: Sequence[IndexedFile] = (),
        deleted_paths: Sequence[str] = (),
    ) -> IndexWriteResult:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        validated_upserts = tuple(_validated_file(file) for file in upserts)
        validated_deletions = tuple(_relative_path(value) for value in deleted_paths)
        if len(validated_upserts) + len(validated_deletions) > MAX_FILE_CHANGES_PER_BATCH:
            raise KnowledgeRepositoryValidationError("The file-change batch is too large.")

        upsert_paths = [file.relative_path for file in validated_upserts]
        if len(set(upsert_paths)) != len(upsert_paths):
            raise KnowledgeRepositoryValidationError("File upsert paths must be unique.")
        if len(set(validated_deletions)) != len(validated_deletions):
            raise KnowledgeRepositoryValidationError("Deleted file paths must be unique.")
        if set(upsert_paths).intersection(validated_deletions):
            raise KnowledgeRepositoryValidationError(
                "A file cannot be replaced and deleted in the same batch."
            )

        try:
            with self._store.transaction() as connection:
                workspace_id = self._workspace_id(connection, validated_key)
                metadata_row = connection.execute(
                    "SELECT chunking_version FROM index_metadata WHERE workspace_id = ?",
                    (workspace_id,),
                ).fetchone()
                if metadata_row is None:
                    raise KnowledgeRepositoryError("The workspace index metadata is missing.")
                expected_chunking_version = int(metadata_row["chunking_version"])
                if any(
                    chunk.chunking_version != expected_chunking_version
                    for file in validated_upserts
                    for chunk in file.chunks
                ):
                    raise KnowledgeRepositoryValidationError(
                        "Indexed chunks do not match the workspace chunking version."
                    )
                deleted_files = 0
                for relative_path in validated_deletions:
                    cursor = connection.execute(
                        "DELETE FROM files WHERE workspace_id = ? AND relative_path = ?",
                        (workspace_id, relative_path),
                    )
                    deleted_files += max(cursor.rowcount, 0)

                for file in validated_upserts:
                    self._replace_file(connection, workspace_id, file)
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError("The file-index changes could not be applied.") from error

        return IndexWriteResult(
            upserted_files=len(validated_upserts),
            deleted_files=deleted_files,
        )

    def delete_workspace(self, workspace_key: str) -> bool:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        try:
            with self._store.transaction() as connection:
                cursor = connection.execute(
                    "DELETE FROM workspaces WHERE workspace_key = ?",
                    (validated_key,),
                )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError("The workspace index could not be deleted.") from error
        return cursor.rowcount > 0

    def update_index_metadata(
        self,
        workspace_key: str,
        *,
        chunking_version: int,
        index_state: IndexState,
        last_full_scan_at: str | None = None,
    ) -> IndexMetadataRecord:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        validated_version = _positive_integer(chunking_version, "chunking version")
        if index_state not in _INDEX_STATES:
            raise KnowledgeRepositoryValidationError("The index state is invalid.")
        validated_scan_time = (
            _bounded_text(last_full_scan_at, "last full scan", 128)
            if last_full_scan_at is not None
            else None
        )
        try:
            with self._store.transaction() as connection:
                workspace_id = self._workspace_id(connection, validated_key)
                if index_state == "ready":
                    mismatched_chunks = connection.execute(
                        """
                        SELECT COUNT(*)
                        FROM chunks
                        JOIN files ON files.id = chunks.file_id
                        WHERE files.workspace_id = ? AND chunks.chunking_version <> ?
                        """,
                        (workspace_id, validated_version),
                    ).fetchone()[0]
                    if int(mismatched_chunks) > 0:
                        raise KnowledgeRepositoryValidationError(
                            "The index cannot be ready while chunk versions differ."
                        )
                connection.execute(
                    """
                    UPDATE index_metadata
                    SET chunking_version = ?,
                        index_state = ?,
                        last_full_scan_at = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE workspace_id = ?
                    """,
                    (
                        validated_version,
                        index_state,
                        validated_scan_time,
                        workspace_id,
                    ),
                )
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError("The index metadata could not be updated.") from error
        metadata = self.index_metadata(validated_key)
        if metadata is None:
            raise KnowledgeRepositoryError("The index metadata could not be updated.")
        return metadata

    def index_metadata(self, workspace_key: str) -> IndexMetadataRecord | None:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        row = self._store.connection.execute(
            """
            SELECT
                workspaces.workspace_key,
                index_metadata.chunking_version,
                index_metadata.index_state,
                index_metadata.last_full_scan_at
            FROM index_metadata
            JOIN workspaces ON workspaces.id = index_metadata.workspace_id
            WHERE workspaces.workspace_key = ?
            """,
            (validated_key,),
        ).fetchone()
        if row is None:
            return None
        return IndexMetadataRecord(
            workspace_key=str(row["workspace_key"]),
            chunking_version=int(row["chunking_version"]),
            index_state=str(row["index_state"]),  # type: ignore[arg-type]
            last_full_scan_at=(
                str(row["last_full_scan_at"])
                if row["last_full_scan_at"] is not None
                else None
            ),
        )

    def search_lexical(
        self,
        workspace_key: str,
        query: str,
        *,
        limit: int,
    ) -> tuple[LexicalSearchResult, ...]:
        validated_key = _bounded_text(
            workspace_key,
            "workspace key",
            MAX_WORKSPACE_KEY_CHARACTERS,
        )
        if not isinstance(query, str) or len(query) > MAX_LEXICAL_QUERY_CHARACTERS:
            raise KnowledgeRepositoryValidationError("The lexical query is invalid.")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LEXICAL_RESULTS:
            raise KnowledgeRepositoryValidationError("The lexical result limit is invalid.")
        fts_query = _fts_query(query)
        if fts_query is None:
            return ()

        try:
            rows = self._store.connection.execute(
                """
                SELECT
                    files.relative_path,
                    files.language_id,
                    chunks.stable_id,
                    chunks.ordinal,
                    chunks.start_line,
                    chunks.end_line,
                    chunks.content,
                    chunks.content_hash,
                    bm25(chunks_fts) AS lexical_rank
                FROM chunks_fts
                JOIN chunks ON chunks.id = chunks_fts.rowid
                JOIN files ON files.id = chunks.file_id
                JOIN workspaces ON workspaces.id = files.workspace_id
                WHERE workspaces.workspace_key = ? AND chunks_fts MATCH ?
                ORDER BY
                    lexical_rank ASC,
                    files.relative_path COLLATE NOCASE ASC,
                    chunks.ordinal ASC
                LIMIT ?
                """,
                (validated_key, fts_query, limit),
            ).fetchall()
        except sqlite3.Error as error:
            raise KnowledgeRepositoryError("The lexical index search failed.") from error

        return tuple(
            LexicalSearchResult(
                relative_path=str(row["relative_path"]),
                language_id=str(row["language_id"]),
                stable_id=str(row["stable_id"]),
                ordinal=int(row["ordinal"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                content=str(row["content"]),
                content_hash=str(row["content_hash"]),
                score=-float(row["lexical_rank"]),
            )
            for row in rows
        )

    @staticmethod
    def _workspace_id(connection: sqlite3.Connection, workspace_key: str) -> int:
        row = connection.execute(
            "SELECT id FROM workspaces WHERE workspace_key = ?",
            (workspace_key,),
        ).fetchone()
        if row is None:
            raise KnowledgeRepositoryNotFoundError("The workspace index does not exist.")
        return int(row["id"])

    @staticmethod
    def _replace_file(
        connection: sqlite3.Connection,
        workspace_id: int,
        file: IndexedFile,
    ) -> None:
        connection.execute(
            """
            INSERT INTO files(
                workspace_id,
                relative_path,
                language_id,
                content_hash,
                size_bytes,
                modified_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
                language_id = excluded.language_id,
                content_hash = excluded.content_hash,
                size_bytes = excluded.size_bytes,
                modified_at = excluded.modified_at,
                indexed_at = CURRENT_TIMESTAMP
            """,
            (
                workspace_id,
                file.relative_path,
                file.language_id,
                file.content_hash,
                file.size_bytes,
                file.modified_at,
            ),
        )
        row = connection.execute(
            "SELECT id FROM files WHERE workspace_id = ? AND relative_path = ?",
            (workspace_id, file.relative_path),
        ).fetchone()
        if row is None:
            raise KnowledgeRepositoryError("The indexed file could not be stored.")
        file_id = int(row["id"])
        connection.execute("DELETE FROM chunks WHERE file_id = ?", (file_id,))
        connection.executemany(
            """
            INSERT INTO chunks(
                file_id,
                stable_id,
                ordinal,
                start_line,
                end_line,
                content,
                content_hash,
                chunking_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    file_id,
                    chunk.stable_id,
                    chunk.ordinal,
                    chunk.start_line,
                    chunk.end_line,
                    chunk.content,
                    chunk.content_hash,
                    chunk.chunking_version,
                )
                for chunk in file.chunks
            ),
        )


def _validated_file(file: IndexedFile) -> IndexedFile:
    if not isinstance(file, IndexedFile):
        raise KnowledgeRepositoryValidationError("The indexed file is invalid.")
    relative_path = _relative_path(file.relative_path)
    language_id = _bounded_text(
        file.language_id,
        "language identifier",
        MAX_LANGUAGE_ID_CHARACTERS,
    )
    content_hash = _bounded_text(
        file.content_hash,
        "file content hash",
        MAX_CONTENT_HASH_CHARACTERS,
    )
    size_bytes = _nonnegative_integer(file.size_bytes, "file size")
    modified_at = _nonnegative_integer(file.modified_at, "file modification time")
    if len(file.chunks) > MAX_CHUNKS_PER_FILE:
        raise KnowledgeRepositoryValidationError("The indexed file has too many chunks.")

    chunks = tuple(_validated_chunk(chunk) for chunk in file.chunks)
    ordinals = [chunk.ordinal for chunk in chunks]
    if ordinals != list(range(len(chunks))):
        raise KnowledgeRepositoryValidationError("Chunk ordinals must be contiguous and ordered.")
    stable_ids = [chunk.stable_id for chunk in chunks]
    if len(set(stable_ids)) != len(stable_ids):
        raise KnowledgeRepositoryValidationError("Chunk stable identifiers must be unique.")
    versions = {chunk.chunking_version for chunk in chunks}
    if len(versions) > 1:
        raise KnowledgeRepositoryValidationError("File chunks must use one chunking version.")

    return IndexedFile(
        relative_path=relative_path,
        language_id=language_id,
        content_hash=content_hash,
        size_bytes=size_bytes,
        modified_at=modified_at,
        chunks=chunks,
    )


def _validated_chunk(chunk: IndexedChunk) -> IndexedChunk:
    if not isinstance(chunk, IndexedChunk):
        raise KnowledgeRepositoryValidationError("The indexed chunk is invalid.")
    stable_id = _bounded_text(
        chunk.stable_id,
        "chunk stable identifier",
        MAX_CHUNK_STABLE_ID_CHARACTERS,
    )
    ordinal = _nonnegative_integer(chunk.ordinal, "chunk ordinal")
    start_line = _positive_integer(chunk.start_line, "chunk start line")
    end_line = _positive_integer(chunk.end_line, "chunk end line")
    if end_line < start_line:
        raise KnowledgeRepositoryValidationError("The chunk line range is invalid.")
    content = _bounded_content(chunk.content)
    content_hash = _bounded_text(
        chunk.content_hash,
        "chunk content hash",
        MAX_CONTENT_HASH_CHARACTERS,
    )
    chunking_version = _positive_integer(chunk.chunking_version, "chunking version")
    return IndexedChunk(
        stable_id=stable_id,
        ordinal=ordinal,
        start_line=start_line,
        end_line=end_line,
        content=content,
        content_hash=content_hash,
        chunking_version=chunking_version,
    )


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


def _bounded_content(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_CHUNK_CHARACTERS
        or "\0" in value
    ):
        raise KnowledgeRepositoryValidationError("The chunk content is invalid.")
    return value


def _absolute_root_path(value: object) -> str:
    root_path = _bounded_text(value, "workspace root", MAX_WORKSPACE_ROOT_CHARACTERS)
    if not Path(root_path).is_absolute():
        raise KnowledgeRepositoryValidationError("The workspace root must be absolute.")
    return root_path


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


def _fts_query(value: str) -> str | None:
    terms: list[str] = []
    seen: set[str] = set()
    for match in _SEARCH_TERM_PATTERN.finditer(value):
        term = match.group(0)[:128]
        normalized = term.casefold()
        if normalized in seen:
            continue
        seen.add(normalized)
        terms.append(term)
        if len(terms) >= MAX_LEXICAL_QUERY_TERMS:
            break
    if not terms:
        return None
    return " OR ".join(f'"{term}"' for term in terms)
