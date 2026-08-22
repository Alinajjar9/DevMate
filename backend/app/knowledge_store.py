from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class KnowledgeStoreError(RuntimeError):
    """Raised when the local knowledge store cannot be used safely."""


class KnowledgeStoreMigrationError(KnowledgeStoreError):
    """Raised when the database schema is incompatible or cannot be migrated."""


@dataclass(frozen=True, slots=True)
class SchemaMigration:
    version: int
    name: str
    statements: tuple[str, ...]


_SCHEMA_MIGRATIONS = (
    SchemaMigration(
        version=1,
        name="initial_knowledge_store",
        statements=(
            """
            CREATE TABLE workspaces (
                id INTEGER PRIMARY KEY,
                workspace_key TEXT NOT NULL UNIQUE CHECK (length(workspace_key) > 0),
                root_path TEXT NOT NULL CHECK (length(root_path) > 0),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE files (
                id INTEGER PRIMARY KEY,
                workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
                language_id TEXT NOT NULL,
                content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
                size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
                modified_at INTEGER NOT NULL CHECK (modified_at >= 0),
                indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (workspace_id, relative_path)
            )
            """,
            """
            CREATE TABLE chunks (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                stable_id TEXT NOT NULL CHECK (length(stable_id) > 0),
                ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                start_line INTEGER NOT NULL CHECK (start_line >= 1),
                end_line INTEGER NOT NULL CHECK (end_line >= start_line),
                content TEXT NOT NULL CHECK (length(content) > 0),
                content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
                chunking_version INTEGER NOT NULL CHECK (chunking_version >= 1),
                UNIQUE (file_id, stable_id),
                UNIQUE (file_id, ordinal)
            )
            """,
            """
            CREATE VIRTUAL TABLE chunks_fts USING fts5(
                content,
                content='chunks',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )
            """,
            """
            CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
            END
            """,
            """
            CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
            END
            """,
            """
            CREATE TRIGGER chunks_fts_update AFTER UPDATE OF content ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
                INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
            END
            """,
            """
            CREATE TABLE embeddings (
                id INTEGER PRIMARY KEY,
                chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
                profile_id TEXT NOT NULL CHECK (length(profile_id) > 0),
                provider TEXT NOT NULL CHECK (length(provider) > 0),
                model TEXT NOT NULL CHECK (length(model) > 0),
                dimensions INTEGER NOT NULL CHECK (dimensions > 0),
                vector_version INTEGER NOT NULL CHECK (vector_version >= 1),
                normalized INTEGER NOT NULL DEFAULT 1 CHECK (normalized = 1),
                vector BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (chunk_id, profile_id, model, dimensions, vector_version)
            )
            """,
            """
            CREATE TABLE index_metadata (
                workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
                chunking_version INTEGER NOT NULL CHECK (chunking_version >= 1),
                embedding_profile_id TEXT,
                embedding_model TEXT,
                embedding_dimensions INTEGER CHECK (
                    embedding_dimensions IS NULL OR embedding_dimensions > 0
                ),
                vector_version INTEGER CHECK (vector_version IS NULL OR vector_version >= 1),
                index_state TEXT NOT NULL DEFAULT 'empty' CHECK (
                    index_state IN ('empty', 'indexing', 'ready', 'stale', 'failed')
                ),
                last_full_scan_at TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """,
            "CREATE INDEX files_workspace_id_index ON files(workspace_id)",
            "CREATE INDEX chunks_file_id_index ON chunks(file_id)",
            """
            CREATE INDEX embeddings_profile_index
            ON embeddings(profile_id, model, dimensions, vector_version)
            """,
        ),
    ),
)
KNOWLEDGE_SCHEMA_VERSION = _SCHEMA_MIGRATIONS[-1].version


class KnowledgeStore:
    """Owns one explicitly located, versioned SQLite knowledge database."""

    def __init__(self, database_path: str | Path) -> None:
        path = Path(database_path)
        if not path.is_absolute():
            raise ValueError("The knowledge-store database path must be absolute.")
        self.database_path = path
        self._connection: sqlite3.Connection | None = None

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise KnowledgeStoreError("The knowledge store is not open.")
        return self._connection

    def open(self) -> KnowledgeStore:
        if self._connection is not None:
            return self

        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            self.database_path,
            timeout=5.0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        try:
            self._configure(connection)
            self._migrate(connection)
        except Exception:
            connection.close()
            raise
        self._connection = connection
        return self

    def close(self) -> None:
        if self._connection is None:
            return
        self._connection.close()
        self._connection = None

    def __enter__(self) -> KnowledgeStore:
        return self.open()

    def __exit__(self, _error_type, _error, _traceback) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connection
        if connection.in_transaction:
            raise KnowledgeStoreError("Nested knowledge-store transactions are not supported.")
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except Exception:
            connection.rollback()
            raise
        else:
            connection.commit()

    @staticmethod
    def _configure(connection: sqlite3.Connection) -> None:
        connection.execute("PRAGMA foreign_keys = ON")
        foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
        if foreign_keys != 1:
            raise KnowledgeStoreError("SQLite foreign-key enforcement is unavailable.")

        journal_mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if str(journal_mode).lower() != "wal":
            raise KnowledgeStoreError("SQLite WAL mode is unavailable for the knowledge store.")

        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA busy_timeout = 5000")

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY CHECK (version >= 1),
                name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        applied_rows = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        known_migrations = {migration.version: migration for migration in _SCHEMA_MIGRATIONS}
        applied_versions = [int(row["version"]) for row in applied_rows]

        if applied_versions != list(range(1, len(applied_versions) + 1)):
            raise KnowledgeStoreMigrationError("Knowledge-store migrations are not contiguous.")
        for row in applied_rows:
            migration = known_migrations.get(int(row["version"]))
            if migration is None or migration.name != row["name"]:
                raise KnowledgeStoreMigrationError(
                    "The knowledge-store schema is newer or incompatible."
                )

        user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        current_version = applied_versions[-1] if applied_versions else 0
        if user_version != current_version:
            raise KnowledgeStoreMigrationError(
                "The knowledge-store schema version metadata is inconsistent."
            )

        for migration in _SCHEMA_MIGRATIONS:
            if migration.version <= current_version:
                continue
            connection.execute("BEGIN IMMEDIATE")
            try:
                for statement in migration.statements:
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO schema_migrations(version, name) VALUES (?, ?)",
                    (migration.version, migration.name),
                )
                connection.execute(f"PRAGMA user_version = {migration.version}")
                connection.commit()
            except sqlite3.Error as error:
                connection.rollback()
                raise KnowledgeStoreMigrationError(
                    f"Could not apply knowledge-store migration {migration.version}."
                ) from error

        final_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if final_version != KNOWLEDGE_SCHEMA_VERSION:
            raise KnowledgeStoreMigrationError(
                "The knowledge-store schema did not reach the expected version."
            )
