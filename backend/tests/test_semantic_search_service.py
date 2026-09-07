import math
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.providers.embedding_providers import EmbeddingBatch, EmbeddingRequest
from backend.app.indexing.embedding_repository import (
    ChunkEmbeddingWrite,
    EmbeddingConfiguration,
    EmbeddingRepository,
)
from backend.app.indexing.knowledge_repository import IndexedChunk, IndexedFile, KnowledgeRepository
from backend.app.knowledge_store import KnowledgeStore
from backend.app.indexing.semantic_search_service import (
    SemanticSearchError,
    SemanticSearchService,
)
from backend.app.providers.embedding_providers import EmbeddingProfile


class QueryEmbeddingProvider:
    def __init__(self, vector: tuple[float, ...] = (1.0, 0.0)) -> None:
        self.vector = vector
        self.requests: list[EmbeddingRequest] = []

    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
        self.requests.append(request)
        return EmbeddingBatch(
            model=request.model,
            dimensions=len(self.vector),
            vectors=(self.vector,),
        )


class SemanticSearchServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(
            self.temporary_directory / "semantic-search-service.sqlite3"
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
                self._file("src/auth.py", "validate session credentials"),
                self._file("src/catalog.py", "list products for sale"),
                self._file("src/worker.py", "run delayed background jobs"),
            ),
        )
        self.configuration = EmbeddingConfiguration(
            profile_id="local-embedding",
            provider="ollama",
            model="nomic-embed-text",
            dimensions=2,
            vector_version=1,
        )
        self.profile = EmbeddingProfile(
            profile_id="local-embedding",
            provider="ollama",
            model="nomic-embed-text",
            base_url="http://127.0.0.1:11434",
            api_key="query-secret",
        )

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    async def test_embeds_once_and_exactly_ranks_every_cached_vector_in_pages(self) -> None:
        self._store_vectors({
            "src/auth.py": (0.8, 0.6),
            "src/catalog.py": (-1.0, 0.0),
            "src/worker.py": (1.0, 0.0),
        })
        provider = QueryEmbeddingProvider()
        service = SemanticSearchService(
            provider,
            self.embedding_repository,
            read_batch_size=1,
        )

        result = await service.search_workspace(
            "workspace-one",
            "Where are asynchronous tasks executed?",
            self.profile,
            limit=2,
        )

        self.assertEqual(result.configuration, self.configuration)
        self.assertEqual(
            [match.relative_path for match in result.matches],
            ["src/worker.py", "src/auth.py"],
        )
        self.assertAlmostEqual(result.matches[0].score, 1.0)
        self.assertAlmostEqual(result.matches[1].score, 0.8, places=6)
        self.assertEqual(len(provider.requests), 1)
        self.assertEqual(provider.requests[0].inputs, (
            "Where are asynchronous tasks executed?",
        ))
        self.assertEqual(provider.requests[0].api_key, "query-secret")

    async def test_skips_the_provider_when_the_selected_index_is_unavailable(self) -> None:
        provider = QueryEmbeddingProvider()
        service = SemanticSearchService(provider, self.embedding_repository)

        result = await service.search_workspace(
            "workspace-one",
            "authentication logic",
            self.profile,
            limit=5,
        )

        self.assertIsNone(result.configuration)
        self.assertEqual(result.matches, ())
        self.assertEqual(provider.requests, [])

    async def test_rejects_wrong_dimensions_and_non_normalized_query_vectors(self) -> None:
        self._store_vectors({
            "src/auth.py": (1.0, 0.0),
            "src/catalog.py": (0.0, 1.0),
            "src/worker.py": (-1.0, 0.0),
        })
        for vector in ((1.0,), (1.0, 1.0), (math.nan, 0.0)):
            with self.subTest(vector=vector):
                service = SemanticSearchService(
                    QueryEmbeddingProvider(vector),
                    self.embedding_repository,
                )
                with self.assertRaisesRegex(SemanticSearchError, "query vector"):
                    await service.search_workspace(
                        "workspace-one",
                        "authentication logic",
                        self.profile,
                        limit=5,
                    )

    async def test_rejects_unbounded_queries_limits_and_read_batches(self) -> None:
        provider = QueryEmbeddingProvider()
        service = SemanticSearchService(provider, self.embedding_repository)
        for query, limit in (("", 5), ("x" * 2_001, 5), ("valid", 0), ("valid", 101)):
            with self.subTest(query_length=len(query), limit=limit):
                with self.assertRaises(SemanticSearchError):
                    await service.search_workspace(
                        "workspace-one",
                        query,
                        self.profile,
                        limit=limit,
                    )
        with self.assertRaises(ValueError):
            SemanticSearchService(provider, self.embedding_repository, read_batch_size=0)
        self.assertEqual(provider.requests, [])

    def _store_vectors(self, vectors: dict[str, tuple[float, ...]]) -> None:
        self.embedding_repository.activate_configuration(
            "workspace-one",
            self.configuration,
        )
        pending = self.embedding_repository.chunks_missing_embeddings(
            "workspace-one",
            self.configuration,
            limit=10,
        )
        self.embedding_repository.store_embeddings(
            "workspace-one",
            self.configuration,
            tuple(
                ChunkEmbeddingWrite(
                    relative_path=chunk.relative_path,
                    stable_id=chunk.stable_id,
                    content_hash=chunk.content_hash,
                    vector=vectors[chunk.relative_path],
                )
                for chunk in pending
            ),
        )

    @staticmethod
    def _file(relative_path: str, content: str) -> IndexedFile:
        return IndexedFile(
            relative_path=relative_path,
            language_id="python",
            content_hash=f"file-{relative_path}",
            size_bytes=len(content.encode("utf-8")),
            modified_at=1,
            chunks=(IndexedChunk(
                stable_id=f"{relative_path}:1-1:0",
                ordinal=0,
                start_line=1,
                end_line=1,
                content=content,
                content_hash=f"chunk-{relative_path}",
                chunking_version=1,
            ),),
        )


if __name__ == "__main__":
    unittest.main()
