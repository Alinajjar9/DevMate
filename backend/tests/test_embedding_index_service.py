import asyncio
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.embedding_index_service import (
    EmbeddingIndexError,
    EmbeddingIndexProfile,
    EmbeddingIndexService,
)
from backend.app.embedding_providers import EmbeddingBatch, EmbeddingRequest
from backend.app.embedding_repository import EmbeddingRepository
from backend.app.knowledge_repository import (
    IndexedChunk,
    IndexedFile,
    KnowledgeRepository,
    KnowledgeRepositoryNotFoundError,
)
from backend.app.knowledge_store import KnowledgeStore


class RecordingEmbeddingProvider:
    def __init__(
        self,
        *,
        dimensions: int = 2,
        fail_on_call: int | None = None,
        cancel_on_call: int | None = None,
        vector_count_offset: int = 0,
    ) -> None:
        self.dimensions = dimensions
        self.fail_on_call = fail_on_call
        self.cancel_on_call = cancel_on_call
        self.vector_count_offset = vector_count_offset
        self.requests: list[EmbeddingRequest] = []

    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
        self.requests.append(request)
        call_number = len(self.requests)
        if call_number == self.fail_on_call:
            raise RuntimeError("embedding provider failed")
        if call_number == self.cancel_on_call:
            raise asyncio.CancelledError
        vector_count = len(request.inputs) + self.vector_count_offset
        vector = (1.0,) + ((0.0,) * (self.dimensions - 1))
        return EmbeddingBatch(
            model=request.model,
            dimensions=self.dimensions,
            vectors=tuple(vector for _ in range(max(vector_count, 0))),
        )


class EmbeddingIndexServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(
            self.temporary_directory / "embedding-index-service.sqlite3"
        ).open()
        self.knowledge_repository = KnowledgeRepository(self.store)
        self.embedding_repository = EmbeddingRepository(self.store)
        self.knowledge_repository.register_workspace(
            "workspace-one",
            str(self.temporary_directory / "workspace"),
            chunking_version=1,
        )

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    async def test_discovers_dimensions_and_resumes_only_missing_chunks(self) -> None:
        self._seed("alpha", "bravo", "charlie", "delta", "echo")
        provider = RecordingEmbeddingProvider(dimensions=3)
        service = EmbeddingIndexService(provider, self.embedding_repository)

        first = await service.synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=2,
            max_batches=1,
        )
        second = await service.synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=2,
            max_batches=2,
        )

        self.assertFalse(first.complete)
        self.assertEqual(first.embedded_chunks, 2)
        self.assertEqual(first.processed_batches, 1)
        self.assertEqual(first.configuration.dimensions, 3)  # type: ignore[union-attr]
        self.assertTrue(second.complete)
        self.assertEqual(second.embedded_chunks, 3)
        self.assertEqual(second.processed_batches, 2)
        self.assertEqual(
            [request.inputs for request in provider.requests],
            [
                ("alpha", "bravo"),
                ("charlie", "delta"),
                ("echo",),
            ],
        )
        stored = self.embedding_repository.load_embeddings(
            "workspace-one",
            second.configuration,  # type: ignore[arg-type]
        )
        self.assertEqual(len(stored), 5)
        self.assertTrue(all(len(item.vector) == 3 for item in stored))

    async def test_keeps_completed_batches_when_a_later_provider_call_fails(self) -> None:
        self._seed("alpha", "bravo", "charlie")
        failing_provider = RecordingEmbeddingProvider(fail_on_call=2)
        service = EmbeddingIndexService(
            failing_provider,
            self.embedding_repository,
        )

        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            await service.synchronize_workspace(
                "workspace-one",
                self._profile(),
                batch_size=1,
                max_batches=3,
            )

        configuration = self._active_configuration()
        self.assertEqual(len(self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
        )), 1)

        recovery_provider = RecordingEmbeddingProvider()
        recovered = await EmbeddingIndexService(
            recovery_provider,
            self.embedding_repository,
        ).synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=1,
            max_batches=2,
        )

        self.assertTrue(recovered.complete)
        self.assertEqual(
            [request.inputs for request in recovery_provider.requests],
            [("bravo",), ("charlie",)],
        )

    async def test_keeps_completed_batches_when_a_later_call_is_cancelled(self) -> None:
        self._seed("alpha", "bravo")
        provider = RecordingEmbeddingProvider(cancel_on_call=2)

        with self.assertRaises(asyncio.CancelledError):
            await EmbeddingIndexService(
                provider,
                self.embedding_repository,
            ).synchronize_workspace(
                "workspace-one",
                self._profile(),
                batch_size=1,
                max_batches=2,
            )

        configuration = self._active_configuration()
        stored = self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
        )
        self.assertEqual([item.content for item in stored], ["alpha"])

    async def test_dimension_change_rebuilds_all_workspace_vectors(self) -> None:
        self._seed("alpha", "bravo", "charlie")
        initial = await EmbeddingIndexService(
            RecordingEmbeddingProvider(dimensions=2),
            self.embedding_repository,
        ).synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=3,
        )
        self.assertTrue(initial.complete)

        self.knowledge_repository.apply_file_changes(
            "workspace-one",
            upserts=(self._file(0, "alpha updated"),),
        )
        changed_provider = RecordingEmbeddingProvider(dimensions=3)
        rebuilt = await EmbeddingIndexService(
            changed_provider,
            self.embedding_repository,
        ).synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=1,
            max_batches=3,
        )

        self.assertTrue(rebuilt.complete)
        self.assertEqual(rebuilt.embedded_chunks, 3)
        self.assertEqual(rebuilt.configuration.dimensions, 3)  # type: ignore[union-attr]
        self.assertEqual(
            [request.inputs for request in changed_provider.requests],
            [("alpha updated",), ("bravo",), ("charlie",)],
        )
        stored = self.embedding_repository.load_embeddings(
            "workspace-one",
            rebuilt.configuration,  # type: ignore[arg-type]
        )
        self.assertEqual(len(stored), 3)
        self.assertTrue(all(len(item.vector) == 3 for item in stored))

    async def test_stale_first_batch_can_resume_with_discovered_dimensions(self) -> None:
        self._seed("alpha")

        class MutatingProvider(RecordingEmbeddingProvider):
            async def embed(inner_self, request: EmbeddingRequest) -> EmbeddingBatch:
                result = await super(MutatingProvider, inner_self).embed(request)
                self.knowledge_repository.apply_file_changes(
                    "workspace-one",
                    upserts=(self._file(0, "alpha updated"),),
                )
                return result

        with self.assertRaisesRegex(
            KnowledgeRepositoryNotFoundError,
            "missing or stale",
        ):
            await EmbeddingIndexService(
                MutatingProvider(),
                self.embedding_repository,
            ).synchronize_workspace("workspace-one", self._profile())

        recovered_provider = RecordingEmbeddingProvider()
        recovered = await EmbeddingIndexService(
            recovered_provider,
            self.embedding_repository,
        ).synchronize_workspace("workspace-one", self._profile())

        self.assertTrue(recovered.complete)
        self.assertEqual(recovered_provider.requests[0].inputs, ("alpha updated",))

    async def test_caps_a_provider_batch_by_total_source_characters(self) -> None:
        self._seed(*(chr(65 + index) * 20_000 for index in range(13)))
        provider = RecordingEmbeddingProvider()

        result = await EmbeddingIndexService(
            provider,
            self.embedding_repository,
        ).synchronize_workspace(
            "workspace-one",
            self._profile(),
            batch_size=64,
            max_batches=1,
        )

        self.assertFalse(result.complete)
        self.assertEqual(len(provider.requests[0].inputs), 12)
        self.assertLessEqual(
            sum(len(value) for value in provider.requests[0].inputs),
            256_000,
        )

    async def test_rejects_wrong_vector_count_without_activating_a_profile(self) -> None:
        self._seed("alpha", "bravo")
        provider = RecordingEmbeddingProvider(vector_count_offset=-1)

        with self.assertRaisesRegex(EmbeddingIndexError, "wrong number"):
            await EmbeddingIndexService(
                provider,
                self.embedding_repository,
            ).synchronize_workspace("workspace-one", self._profile())

        self.assertIsNone(self._active_configuration(required=False))
        self.assertEqual(
            self.store.connection.execute(
                "SELECT COUNT(*) FROM embeddings"
            ).fetchone()[0],
            0,
        )

    async def test_malformed_new_dimensions_do_not_remove_cached_vectors(self) -> None:
        self._seed("alpha", "bravo")
        await EmbeddingIndexService(
            RecordingEmbeddingProvider(dimensions=2),
            self.embedding_repository,
        ).synchronize_workspace("workspace-one", self._profile())
        self.knowledge_repository.apply_file_changes(
            "workspace-one",
            upserts=(self._file(0, "alpha updated"),),
        )

        class MalformedProvider:
            async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
                return EmbeddingBatch(
                    model=request.model,
                    dimensions=3,
                    vectors=tuple((2.0, 0.0, 0.0) for _ in request.inputs),
                )

        with self.assertRaisesRegex(EmbeddingIndexError, "invalid vector"):
            await EmbeddingIndexService(
                MalformedProvider(),
                self.embedding_repository,
            ).synchronize_workspace("workspace-one", self._profile())

        configuration = self._active_configuration()
        self.assertEqual(configuration.dimensions, 2)
        stored = self.embedding_repository.load_embeddings(
            "workspace-one",
            configuration,
        )
        self.assertEqual([item.content for item in stored], ["bravo"])

    async def test_empty_or_completed_workspace_does_not_call_provider(self) -> None:
        empty_provider = RecordingEmbeddingProvider()
        empty_result = await EmbeddingIndexService(
            empty_provider,
            self.embedding_repository,
        ).synchronize_workspace("workspace-one", self._profile())
        self.assertTrue(empty_result.complete)
        self.assertIsNone(empty_result.configuration)
        self.assertEqual(empty_provider.requests, [])

        self._seed("alpha")
        provider = RecordingEmbeddingProvider()
        service = EmbeddingIndexService(provider, self.embedding_repository)
        await service.synchronize_workspace("workspace-one", self._profile())
        repeated = await service.synchronize_workspace(
            "workspace-one",
            self._profile(),
        )
        self.assertTrue(repeated.complete)
        self.assertEqual(repeated.embedded_chunks, 0)
        self.assertEqual(len(provider.requests), 1)

    def _active_configuration(self, *, required: bool = True):
        profile = self._profile()
        configuration = self.embedding_repository.active_configuration(
            "workspace-one",
            profile_id=profile.profile_id,
            provider=profile.provider,
            model=profile.model,
            vector_version=profile.vector_version,
        )
        if required:
            self.assertIsNotNone(configuration)
        return configuration

    def _seed(self, *contents: str) -> None:
        self.knowledge_repository.apply_file_changes(
            "workspace-one",
            upserts=tuple(
                self._file(index, content)
                for index, content in enumerate(contents)
            ),
        )

    @staticmethod
    def _profile() -> EmbeddingIndexProfile:
        return EmbeddingIndexProfile(
            profile_id="local-embedding",
            provider="ollama",
            model="nomic-embed-text",
            base_url="http://127.0.0.1:11434",
            api_key=None,
        )

    @staticmethod
    def _file(index: int, content: str) -> IndexedFile:
        relative_path = f"src/{index:02d}.py"
        return IndexedFile(
            relative_path=relative_path,
            language_id="python",
            content_hash=f"file-{index}-{len(content)}-{content[:16]}",
            size_bytes=len(content.encode("utf-8")),
            modified_at=len(content),
            chunks=(IndexedChunk(
                stable_id=f"{relative_path}:1-1:0",
                ordinal=0,
                start_line=1,
                end_line=1,
                content=content,
                content_hash=f"chunk-{index}-{len(content)}-{content[:16]}",
                chunking_version=1,
            ),),
        )


if __name__ == "__main__":
    unittest.main()
