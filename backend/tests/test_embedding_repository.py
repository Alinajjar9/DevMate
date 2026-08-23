import math
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.embedding_repository import (
    ChunkEmbeddingWrite,
    EmbeddingConfiguration,
    EmbeddingRepository,
)
from backend.app.knowledge_repository import (
    IndexedChunk,
    IndexedFile,
    KnowledgeRepository,
    KnowledgeRepositoryNotFoundError,
    KnowledgeRepositoryValidationError,
)
from backend.app.knowledge_store import KnowledgeStore


class EmbeddingRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(
            self.temporary_directory / "embedding-repository.sqlite3"
        ).open()
        self.knowledge_repository = KnowledgeRepository(self.store)
        self.embedding_repository = EmbeddingRepository(self.store)
        self.knowledge_repository.register_workspace(
            "workspace-one",
            str(self.temporary_directory / "workspace"),
            chunking_version=1,
        )
        self.knowledge_repository.apply_file_changes(
            "workspace-one",
            upserts=(
                self._file("src/auth.py", "auth", "validate login token"),
                self._file("src/catalog.py", "catalog", "search product catalog"),
            ),
        )

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    def test_discovers_stores_and_reads_normalized_vectors_in_pages(self) -> None:
        configuration = self._configuration()
        self.assertEqual(
            self.embedding_repository.activate_configuration(
                "workspace-one",
                configuration,
            ),
            0,
        )
        pending = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            configuration,
            limit=10,
        )
        self.assertEqual(
            [chunk.relative_path for chunk in pending],
            ["src/auth.py", "src/catalog.py"],
        )

        first_result = self.embedding_repository.store_embeddings(
            "workspace-one",
            configuration,
            (self._write(pending[0], (0.6, 0.8)),),
        )
        self.assertEqual(first_result.stored_embeddings, 1)
        self.assertEqual(
            [chunk.relative_path for chunk in self.embedding_repository.chunks_missing_embeddings(
                "workspace-one",
                configuration,
                limit=10,
            )],
            ["src/catalog.py"],
        )

        self.embedding_repository.store_embeddings(
            "workspace-one",
            configuration,
            (self._write(pending[1], (0.0, -1.0)),),
        )
        first_page = self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
            limit=1,
        )
        second_page = self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
            after_chunk_id=first_page[-1].chunk_id,
            limit=1,
        )

        self.assertEqual(len(first_page), 1)
        self.assertEqual(len(second_page), 1)
        self.assertLess(first_page[0].chunk_id, second_page[0].chunk_id)
        self.assertAlmostEqual(first_page[0].vector[0], 0.6, places=6)
        self.assertAlmostEqual(first_page[0].vector[1], 0.8, places=6)
        self.assertEqual(second_page[0].vector, (0.0, -1.0))
        stored_blob = self.store.connection.execute(
            "SELECT vector FROM embeddings ORDER BY id LIMIT 1"
        ).fetchone()["vector"]
        self.assertEqual(len(stored_blob), configuration.dimensions * 4)

    def test_configuration_changes_and_explicit_reset_remove_stale_vectors(self) -> None:
        local = self._configuration()
        self.embedding_repository.activate_configuration("workspace-one", local)
        pending = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            local,
            limit=10,
        )
        self.embedding_repository.store_embeddings(
            "workspace-one",
            local,
            tuple(self._write(chunk, (1.0, 0.0)) for chunk in pending),
        )
        self.assertEqual(
            self.embedding_repository.activate_configuration(
                "workspace-one",
                local,
            ),
            0,
        )
        self.assertEqual(
            len(self.embedding_repository.load_embeddings(
                "workspace-one",
                local,
            )),
            2,
        )

        remote = EmbeddingConfiguration(
            profile_id=local.profile_id,
            provider="openai-compatible",
            model=local.model,
            dimensions=local.dimensions,
            vector_version=local.vector_version,
        )
        self.assertEqual(
            self.embedding_repository.activate_configuration(
                "workspace-one",
                remote,
            ),
            2,
        )
        self.assertEqual(
            len(self.embedding_repository.chunks_missing_embeddings(
                "workspace-one",
                remote,
                limit=10,
            )),
            2,
        )
        self.embedding_repository.store_embeddings(
            "workspace-one",
            remote,
            (self._write(pending[0], (0.0, 1.0)),),
        )
        self.assertEqual(self.embedding_repository.invalidate("workspace-one"), 1)
        metadata = self.store.connection.execute(
            """
            SELECT
                embedding_profile_id,
                embedding_model,
                embedding_dimensions,
                vector_version
            FROM index_metadata
            """
        ).fetchone()
        self.assertEqual(tuple(metadata), (None, None, None, None))
        with self.assertRaisesRegex(
            KnowledgeRepositoryValidationError,
            "not active",
        ):
            self.embedding_repository.load_embeddings(
                "workspace-one",
                remote,
            )

    def test_stale_target_rolls_back_the_whole_embedding_batch(self) -> None:
        configuration = self._configuration()
        self.embedding_repository.activate_configuration(
            "workspace-one",
            configuration,
        )
        pending = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            configuration,
            limit=10,
        )
        stale_write = ChunkEmbeddingWrite(
            relative_path=pending[1].relative_path,
            stable_id=pending[1].stable_id,
            content_hash="stale-content-hash",
            vector=(0.0, 1.0),
        )

        with self.assertRaisesRegex(
            KnowledgeRepositoryNotFoundError,
            "missing or stale",
        ):
            self.embedding_repository.store_embeddings(
                "workspace-one",
                configuration,
                (
                    self._write(pending[0], (1.0, 0.0)),
                    stale_write,
                ),
            )

        self.assertEqual(
            self.embedding_repository.load_embeddings(
                "workspace-one",
                configuration,
            ),
            (),
        )

    def test_file_replacement_cascades_vectors_and_requeues_current_chunks(self) -> None:
        configuration = self._configuration()
        self.embedding_repository.activate_configuration(
            "workspace-one",
            configuration,
        )
        pending = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            configuration,
            limit=10,
        )
        self.embedding_repository.store_embeddings(
            "workspace-one",
            configuration,
            tuple(self._write(chunk, (1.0, 0.0)) for chunk in pending),
        )

        self.knowledge_repository.apply_file_changes(
            "workspace-one",
            upserts=(self._file(
                "src/auth.py",
                "auth-updated",
                "validate rotated session token",
            ),),
        )

        stored = self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
        )
        missing = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            configuration,
            limit=10,
        )
        self.assertEqual([item.relative_path for item in stored], ["src/catalog.py"])
        self.assertEqual([item.relative_path for item in missing], ["src/auth.py"])
        self.assertEqual(missing[0].content_hash, "chunk-auth-updated")

    def test_rejects_invalid_vectors_duplicates_limits_and_inactive_use(self) -> None:
        configuration = self._configuration()
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "not active"):
            self.embedding_repository.chunks_missing_embeddings(
                "workspace-one",
                configuration,
                limit=10,
            )
        self.embedding_repository.activate_configuration(
            "workspace-one",
            configuration,
        )
        target = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            configuration,
            limit=1,
        )[0]
        for vector in (
            (1.0,),
            (1.0, 1.0),
            (math.nan, 1.0),
            (True, 0.0),
        ):
            with self.subTest(vector=vector):
                with self.assertRaises(KnowledgeRepositoryValidationError):
                    self.embedding_repository.store_embeddings(
                        "workspace-one",
                        configuration,
                        (self._write(target, vector),),
                    )

        valid_write = self._write(target, (1.0, 0.0))
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "unique"):
            self.embedding_repository.store_embeddings(
                "workspace-one",
                configuration,
                (valid_write, valid_write),
            )
        with self.assertRaisesRegex(KnowledgeRepositoryValidationError, "limit"):
            self.embedding_repository.load_embeddings(
                "workspace-one",
                configuration,
                limit=0,
            )
        self.assertEqual(
            self.embedding_repository.load_embeddings(
                "workspace-one",
                configuration,
            ),
            (),
        )

    @staticmethod
    def _configuration() -> EmbeddingConfiguration:
        return EmbeddingConfiguration(
            profile_id="local-embedding",
            provider="ollama",
            model="nomic-embed-text",
            dimensions=2,
            vector_version=1,
        )

    @staticmethod
    def _write(chunk, vector) -> ChunkEmbeddingWrite:
        return ChunkEmbeddingWrite(
            relative_path=chunk.relative_path,
            stable_id=chunk.stable_id,
            content_hash=chunk.content_hash,
            vector=vector,
        )

    @staticmethod
    def _file(relative_path: str, content_hash: str, content: str) -> IndexedFile:
        return IndexedFile(
            relative_path=relative_path,
            language_id="python",
            content_hash=content_hash,
            size_bytes=len(content.encode("utf-8")),
            modified_at=2,
            chunks=(
                IndexedChunk(
                    stable_id=f"{relative_path}:1-1:0",
                    ordinal=0,
                    start_line=1,
                    end_line=1,
                    content=content,
                    content_hash=f"chunk-{content_hash}",
                    chunking_version=1,
                ),
            ),
        )


if __name__ == "__main__":
    unittest.main()
