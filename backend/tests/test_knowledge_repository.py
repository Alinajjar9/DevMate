import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.knowledge_repository import (
    FileFingerprint,
    IndexedChunk,
    IndexedFile,
    KnowledgeRepository,
    KnowledgeRepositoryError,
    KnowledgeRepositoryNotFoundError,
    KnowledgeRepositoryValidationError,
)
from backend.app.knowledge_store import KnowledgeStore


class KnowledgeRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(self.temporary_directory / "repository.sqlite3").open()
        self.repository = KnowledgeRepository(self.store)

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    def test_registers_workspaces_idempotently_and_initializes_metadata(self) -> None:
        first = self.repository.register_workspace(
            "workspace-one",
            str(self.temporary_directory / "first-root"),
            chunking_version=1,
        )
        second = self.repository.register_workspace(
            "workspace-one",
            str(self.temporary_directory / "renamed-root"),
            chunking_version=2,
        )

        self.assertEqual(second.id, first.id)
        self.assertEqual(second.root_path, str(self.temporary_directory / "renamed-root"))
        metadata = self.repository.index_metadata("workspace-one")
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.chunking_version, 1)
        self.assertEqual(metadata.index_state, "stale")

    def test_applies_replacements_and_deletions_as_one_batch(self) -> None:
        self._register_workspace()
        initial = self.repository.apply_file_changes(
            "workspace-one",
            upserts=(
                self._file(
                    "src/auth.py",
                    "old-auth-hash",
                    "def legacy_password_check(value):\n    return bool(value)\n",
                ),
                self._file(
                    "src/unused.py",
                    "unused-hash",
                    "def unused_helper():\n    return None\n",
                ),
            ),
        )

        changed = self.repository.apply_file_changes(
            "workspace-one",
            upserts=(
                self._file(
                    "src/auth.py",
                    "new-auth-hash",
                    (
                        "def validate_login_token(token):\n"
                        "    return bool(token)\n"
                        "# login token login token\n"
                    ),
                ),
            ),
            deleted_paths=("src/unused.py",),
        )

        self.assertEqual(initial.upserted_files, 2)
        self.assertEqual(changed.upserted_files, 1)
        self.assertEqual(changed.deleted_files, 1)
        self.assertEqual(
            self.repository.file_fingerprints("workspace-one"),
            (
                FileFingerprint(
                    relative_path="src/auth.py",
                    content_hash="new-auth-hash",
                    size_bytes=128,
                    modified_at=2,
                ),
            ),
        )
        self.assertEqual(
            [result.relative_path for result in self.repository.search_lexical(
                "workspace-one",
                "login token",
                limit=10,
            )],
            ["src/auth.py"],
        )
        self.assertEqual(
            self.repository.search_lexical("workspace-one", "legacy password", limit=10),
            (),
        )

    def test_lexical_search_is_bounded_safe_and_workspace_isolated(self) -> None:
        self._register_workspace("workspace-one", "one")
        self._register_workspace("workspace-two", "two")
        self.repository.apply_file_changes(
            "workspace-one",
            upserts=(
                self._file(
                    "src/auth.py",
                    "auth-hash",
                    "validate login token and rotate login token safely",
                ),
                self._file(
                    "src/general.py",
                    "general-hash",
                    "login documentation with a generic token example",
                ),
            ),
        )
        self.repository.apply_file_changes(
            "workspace-two",
            upserts=(
                self._file(
                    "src/private.py",
                    "private-hash",
                    "validate login token from another workspace",
                ),
            ),
        )

        results = self.repository.search_lexical(
            "workspace-one",
            '"login OR * token',
            limit=10,
        )

        self.assertEqual(results[0].relative_path, "src/auth.py")
        self.assertEqual({result.relative_path for result in results}, {
            "src/auth.py",
            "src/general.py",
        })
        self.assertTrue(all(result.score >= 0 for result in results))
        self.assertEqual(self.repository.search_lexical("workspace-one", "___", limit=5), ())
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "limit"):
            self.repository.search_lexical("workspace-one", "login", limit=0)

    def test_updates_metadata_and_cascades_workspace_deletion(self) -> None:
        self._register_workspace()
        self.repository.apply_file_changes(
            "workspace-one",
            upserts=(self._file("src/app.py", "app-hash", "print('hello')"),),
        )

        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "cannot be ready"):
            self.repository.update_index_metadata(
                "workspace-one",
                chunking_version=2,
                index_state="ready",
            )

        metadata = self.repository.update_index_metadata(
            "workspace-one",
            chunking_version=1,
            index_state="ready",
            last_full_scan_at="2026-08-22T12:00:00Z",
        )

        self.assertEqual(metadata.index_state, "ready")
        self.assertEqual(metadata.last_full_scan_at, "2026-08-22T12:00:00Z")
        self.assertTrue(self.repository.delete_workspace("workspace-one"))
        self.assertFalse(self.repository.delete_workspace("workspace-one"))
        self.assertIsNone(self.repository.index_metadata("workspace-one"))
        self.assertEqual(self.repository.file_fingerprints("workspace-one"), ())
        self.assertEqual(self.repository.search_lexical("workspace-one", "hello", limit=5), ())

    def test_rolls_back_every_file_when_one_write_fails(self) -> None:
        self._register_workspace()
        self.repository.apply_file_changes(
            "workspace-one",
            upserts=(self._file("src/existing.py", "existing-hash", "existing content"),),
        )
        self.store.connection.execute(
            """
            CREATE TRIGGER reject_test_chunk BEFORE INSERT ON chunks
            WHEN new.content = 'reject transaction'
            BEGIN
                SELECT RAISE(ABORT, 'rejected by test');
            END
            """
        )

        with self.assertRaisesRegex(KnowledgeRepositoryError, "could not be applied"):
            self.repository.apply_file_changes(
                "workspace-one",
                upserts=(
                    self._file("src/first.py", "first-hash", "first new content"),
                    self._file("src/second.py", "second-hash", "reject transaction"),
                ),
                deleted_paths=("src/existing.py",),
            )

        self.assertEqual(
            [fingerprint.relative_path for fingerprint in self.repository.file_fingerprints(
                "workspace-one"
            )],
            ["src/existing.py"],
        )
        self.assertEqual(
            [result.relative_path for result in self.repository.search_lexical(
                "workspace-one",
                "existing",
                limit=5,
            )],
            ["src/existing.py"],
        )

    def test_rejects_ambiguous_batches_versions_and_unknown_workspaces(self) -> None:
        self._register_workspace()
        duplicate = self._file("src/app.py", "first-hash", "first")
        duplicate_with_windows_separators = self._file(
            "src\\app.py",
            "second-hash",
            "second",
        )
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "unique"):
            self.repository.apply_file_changes(
                "workspace-one",
                upserts=(duplicate, duplicate_with_windows_separators),
            )

        wrong_version = self._file(
            "src/versioned.py",
            "versioned-hash",
            "versioned content",
            chunking_version=2,
        )
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "chunking version"):
            self.repository.apply_file_changes(
                "workspace-one",
                upserts=(wrong_version,),
            )

        with self.assertRaisesRegex(KnowledgeRepositoryNotFoundError, "does not exist"):
            self.repository.apply_file_changes(
                "missing-workspace",
                upserts=(duplicate,),
            )
        self.assertEqual(self.repository.file_fingerprints("workspace-one"), ())

    def _register_workspace(
        self,
        workspace_key: str = "workspace-one",
        directory_name: str = "workspace",
    ) -> None:
        self.repository.register_workspace(
            workspace_key,
            str(self.temporary_directory / directory_name),
            chunking_version=1,
        )

    @staticmethod
    def _file(
        relative_path: str,
        content_hash: str,
        content: str,
        *,
        chunking_version: int = 1,
    ) -> IndexedFile:
        return IndexedFile(
            relative_path=relative_path,
            language_id="python",
            content_hash=content_hash,
            size_bytes=128,
            modified_at=2,
            chunks=(
                IndexedChunk(
                    stable_id=f"{relative_path}:1-4",
                    ordinal=0,
                    start_line=1,
                    end_line=4,
                    content=content,
                    content_hash=f"chunk-{content_hash}",
                    chunking_version=chunking_version,
                ),
            ),
        )


if __name__ == "__main__":
    unittest.main()
