import sqlite3
import struct
import shutil
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock
from uuid import uuid4

from backend.app import knowledge_store as knowledge_store_module
from backend.app.knowledge_store import (
    DEVMATE_KNOWLEDGE_STORE_FILE_NAME,
    DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE,
    KNOWLEDGE_SCHEMA_VERSION,
    MAX_KNOWLEDGE_STORE_PATH_CHARACTERS,
    KnowledgeStore,
    KnowledgeStoreError,
    KnowledgeStoreMigrationError,
    SchemaMigration,
    knowledge_store_path_from_environment,
)


class KnowledgeStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.database_path = self.temporary_directory / "devmate.sqlite3"

    def tearDown(self) -> None:
        shutil.rmtree(self.temporary_directory)

    def test_initializes_the_versioned_schema_idempotently(self) -> None:
        required_tables = {
            "schema_migrations",
            "workspaces",
            "files",
            "chunks",
            "chunks_fts",
            "embeddings",
            "index_metadata",
            "chat_sessions",
            "chat_turns",
            "chat_summaries",
            "pinned_memories",
        }

        with KnowledgeStore(self.database_path) as store:
            connection = store.connection
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                )
            }
            self.assertTrue(required_tables.issubset(tables))
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(
                connection.execute("PRAGMA user_version").fetchone()[0],
                KNOWLEDGE_SCHEMA_VERSION,
            )

        with KnowledgeStore(self.database_path) as reopened:
            migrations = reopened.connection.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(row["version"], row["name"]) for row in migrations],
                [
                    (1, "initial_knowledge_store"),
                    (2, "chat_memory_foundation"),
                ],
            )

    def test_upgrades_the_existing_index_without_losing_workspace_data(self) -> None:
        with (
            mock.patch.object(
                knowledge_store_module,
                "_SCHEMA_MIGRATIONS",
                knowledge_store_module._SCHEMA_MIGRATIONS[:1],
            ),
            mock.patch.object(knowledge_store_module, "KNOWLEDGE_SCHEMA_VERSION", 1),
            KnowledgeStore(self.database_path) as store,
        ):
            store.connection.execute(
                "INSERT INTO workspaces(workspace_key, root_path) VALUES (?, ?)",
                ("workspace-one", "/projects/one"),
            )

        with KnowledgeStore(self.database_path) as upgraded:
            workspace = upgraded.connection.execute(
                "SELECT workspace_key, root_path FROM workspaces"
            ).fetchone()
            chat_table = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE name = 'chat_sessions'"
            ).fetchone()
            migrations = upgraded.connection.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()

        self.assertEqual(tuple(workspace), ("workspace-one", "/projects/one"))
        self.assertIsNotNone(chat_table)
        self.assertEqual(
            [(row["version"], row["name"]) for row in migrations],
            [
                (1, "initial_knowledge_store"),
                (2, "chat_memory_foundation"),
            ],
        )

    def test_transactions_commit_or_roll_back_as_one_unit(self) -> None:
        with KnowledgeStore(self.database_path) as store:
            with self.assertRaisesRegex(RuntimeError, "cancel transaction"):
                with store.transaction() as connection:
                    connection.execute(
                        "INSERT INTO workspaces(workspace_key, root_path) VALUES (?, ?)",
                        ("workspace-one", "/projects/one"),
                    )
                    raise RuntimeError("cancel transaction")

            self.assertEqual(
                store.connection.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0],
                0,
            )

            with store.transaction() as connection:
                connection.execute(
                    "INSERT INTO workspaces(workspace_key, root_path) VALUES (?, ?)",
                    ("workspace-one", "/projects/one"),
                )
            self.assertEqual(
                store.connection.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0],
                1,
            )

    def test_failed_migration_rolls_back_schema_and_version_metadata(self) -> None:
        with KnowledgeStore(self.database_path):
            pass

        failing_migration = SchemaMigration(
            version=3,
            name="failing_test_migration",
            statements=(
                "CREATE TABLE migration_should_roll_back(id INTEGER PRIMARY KEY)",
                "THIS IS NOT VALID SQL",
            ),
        )
        with (
            mock.patch.object(
                knowledge_store_module,
                "_SCHEMA_MIGRATIONS",
                (*knowledge_store_module._SCHEMA_MIGRATIONS, failing_migration),
            ),
            mock.patch.object(knowledge_store_module, "KNOWLEDGE_SCHEMA_VERSION", 3),
            self.assertRaisesRegex(KnowledgeStoreMigrationError, "migration 3"),
        ):
            KnowledgeStore(self.database_path).open()

        with closing(sqlite3.connect(self.database_path)) as connection:
            table = connection.execute(
                "SELECT name FROM sqlite_master WHERE name = 'migration_should_roll_back'"
            ).fetchone()
            migration_count = connection.execute(
                "SELECT COUNT(*) FROM schema_migrations"
            ).fetchone()[0]
            user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        self.assertIsNone(table)
        self.assertEqual(migration_count, 2)
        self.assertEqual(user_version, 2)

    def test_foreign_keys_and_fts_follow_the_chunk_lifecycle(self) -> None:
        with KnowledgeStore(self.database_path) as store:
            with store.transaction() as connection:
                workspace_id = connection.execute(
                    "INSERT INTO workspaces(workspace_key, root_path) VALUES (?, ?)",
                    ("workspace-one", "/projects/one"),
                ).lastrowid
                file_id = connection.execute(
                    """
                    INSERT INTO files(
                        workspace_id,
                        relative_path,
                        language_id,
                        content_hash,
                        size_bytes,
                        modified_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (workspace_id, "src/auth.py", "python", "file-hash", 42, 1),
                ).lastrowid
                chunk_id = connection.execute(
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
                        file_id,
                        "src/auth.py:1-2",
                        0,
                        1,
                        2,
                        "def validate_login_token(token): return bool(token)",
                        "chunk-hash",
                        1,
                    ),
                ).lastrowid
                connection.execute(
                    """
                    INSERT INTO embeddings(
                        chunk_id,
                        profile_id,
                        provider,
                        model,
                        dimensions,
                        vector_version,
                        vector
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        "local-embedding",
                        "ollama",
                        "nomic-embed-text",
                        3,
                        1,
                        struct.pack("<3f", 0.0, 0.6, 0.8),
                    ),
                )

            matches = store.connection.execute(
                "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?",
                ("login token",),
            ).fetchall()
            self.assertEqual([row["rowid"] for row in matches], [chunk_id])

            with self.assertRaises(sqlite3.IntegrityError):
                with store.transaction() as connection:
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
                        """,
                        (999, "outside.py", "python", "hash", 1, 1),
                    )

            with store.transaction() as connection:
                connection.execute("DELETE FROM files WHERE id = ?", (file_id,))

            self.assertEqual(
                store.connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
                0,
            )
            self.assertEqual(
                store.connection.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0],
                0,
            )
            self.assertEqual(
                store.connection.execute(
                    "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?",
                    ("login token",),
                ).fetchone()[0],
                0,
            )

    def test_requires_an_open_store_and_an_absolute_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be absolute"):
            KnowledgeStore(Path("devmate.sqlite3"))

        store = KnowledgeStore(self.database_path)
        with self.assertRaisesRegex(KnowledgeStoreError, "not open"):
            _ = store.connection

    def test_reads_only_an_explicit_private_database_path_from_the_environment(self) -> None:
        expected_path = self.temporary_directory / DEVMATE_KNOWLEDGE_STORE_FILE_NAME

        self.assertIsNone(knowledge_store_path_from_environment({}))
        self.assertEqual(
            knowledge_store_path_from_environment({
                DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE: str(expected_path),
            }),
            expected_path,
        )

    def test_rejects_invalid_environment_database_paths(self) -> None:
        invalid_paths = (
            "",
            f"relative/{DEVMATE_KNOWLEDGE_STORE_FILE_NAME}",
            str(self.temporary_directory / "unexpected.sqlite3"),
            str(self.temporary_directory / DEVMATE_KNOWLEDGE_STORE_FILE_NAME) + "\0suffix",
            "x" * (MAX_KNOWLEDGE_STORE_PATH_CHARACTERS + 1),
        )
        for invalid_path in invalid_paths:
            with (
                self.subTest(invalid_path=invalid_path[:80]),
                self.assertRaisesRegex(KnowledgeStoreError, "path is invalid"),
            ):
                knowledge_store_path_from_environment({
                    DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE: invalid_path,
                })


if __name__ == "__main__":
    unittest.main()
