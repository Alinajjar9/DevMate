import os
import shutil
import unittest
from pathlib import Path
from unittest import mock
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.api_models import DEVMATE_BACKEND_TOKEN_HEADER
from backend.app.embedding_index_service import EmbeddingIndexService
from backend.app.embedding_providers import EmbeddingBatch, EmbeddingRequest
from backend.app.embedding_repository import EmbeddingRepository
from backend.app.main import create_app
from backend.app.providers import (
    ChatCompletion,
    ChatCompletionRequest,
    ProviderError,
)
from backend.app.semantic_search_service import SemanticSearchService
from backend.app.knowledge_store import KnowledgeStore


class UnusedProvider:
    async def complete(self, _request: ChatCompletionRequest) -> ChatCompletion:
        raise AssertionError("Index API tests must not call the chat provider.")


class RecordingEmbeddingProvider:
    def __init__(self) -> None:
        self.requests: list[EmbeddingRequest] = []
        self.error: ProviderError | None = None
        self.return_malformed_batch = False

    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return EmbeddingBatch(
            model=request.model,
            dimensions=2,
            vectors=(
                ()
                if self.return_malformed_batch
                else tuple((1.0, 0.0) for _ in request.inputs)
            ),
        )


class KnowledgeIndexApiTests(unittest.TestCase):
    backend_token = "index-backend-token-that-is-long-enough"

    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.workspace_root = self.temporary_directory / "workspace"
        self.store = KnowledgeStore(self.temporary_directory / "index-api.sqlite3")
        self.embedding_provider = RecordingEmbeddingProvider()
        self.embedding_service = EmbeddingIndexService(
            self.embedding_provider,
            EmbeddingRepository(self.store),
        )
        self.semantic_service = SemanticSearchService(
            self.embedding_provider,
            EmbeddingRepository(self.store),
        )
        self.application = create_app(
            chat_provider=UnusedProvider(),
            backend_token_provider=lambda: self.backend_token,
            knowledge_store=self.store,
            embedding_index_service=self.embedding_service,
            semantic_search_service=self.semantic_service,
        )
        self.client_context = TestClient(
            self.application,
            headers={DEVMATE_BACKEND_TOKEN_HEADER: self.backend_token},
        )
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        shutil.rmtree(self.temporary_directory)

    def test_round_trips_open_apply_metadata_and_lexical_search(self) -> None:
        opened = self._open_workspace()
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()["data"]["metadata"], {
            "workspaceKey": "workspace-one",
            "chunkingVersion": 1,
            "indexState": "empty",
            "lastFullScanAt": None,
        })
        self.assertEqual(opened.json()["data"]["files"], [])

        applied = self.client.post(
            "/index/v1/files/apply",
            json={
                "workspaceKey": "workspace-one",
                "upserts": [self._indexed_file()],
                "deletedPaths": [],
            },
        )
        self.assertEqual(applied.status_code, 200)
        self.assertEqual(applied.json(), {
            "status": "ok",
            "data": {"upsertedFiles": 1, "deletedFiles": 0},
        })

        reopened = self._open_workspace()
        self.assertEqual(reopened.json()["data"]["files"], [{
            "relativePath": "src/auth.py",
            "contentHash": "file-auth-hash",
            "sizeBytes": 72,
            "modifiedAt": 100,
        }])

        metadata = self.client.post(
            "/index/v1/metadata/update",
            json={
                "workspaceKey": "workspace-one",
                "chunkingVersion": 1,
                "indexState": "ready",
                "lastFullScanAt": "2026-08-22T12:00:00Z",
            },
        )
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(metadata.json()["data"]["indexState"], "ready")

        searched = self.client.post(
            "/index/v1/search",
            json={
                "workspaceKey": "workspace-one",
                "query": '"login OR * token',
                "limit": 5,
            },
        )
        self.assertEqual(searched.status_code, 200)
        results = searched.json()["data"]["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["relativePath"], "src/auth.py")
        self.assertEqual(results[0]["stableId"], "src/auth.py:1-2")
        self.assertGreaterEqual(results[0]["score"], 0)

    def test_authenticates_every_versioned_index_route_before_validation(self) -> None:
        unauthenticated = TestClient(self.application)
        for path in (
            "/index/v1/workspaces/open",
            "/index/v1/files/apply",
            "/index/v1/metadata/update",
            "/index/v1/search",
            "/index/v1/embeddings/synchronize",
            "/index/v1/embeddings/search",
        ):
            with self.subTest(path=path):
                response = unauthenticated.post(path, json={"private": "workspace source"})
                self.assertEqual(response.status_code, 401)
                self.assertEqual(
                    response.json()["errorCode"],
                    "backend_authentication_failed",
                )
        unauthenticated.close()

    def test_returns_stable_errors_for_invalid_and_unknown_workspace_requests(self) -> None:
        extra_field = self.client.post(
            "/index/v1/workspaces/open",
            json={
                "workspaceKey": "workspace-one",
                "rootPath": str(self.workspace_root),
                "chunkingVersion": 1,
                "unexpected": True,
            },
        )
        self.assertEqual(extra_field.status_code, 422)
        self.assertEqual(extra_field.json()["errorCode"], "request_validation_failed")

        missing = self.client.post(
            "/index/v1/files/apply",
            json={
                "workspaceKey": "missing-workspace",
                "upserts": [self._indexed_file()],
                "deletedPaths": [],
            },
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["errorCode"], "knowledge_workspace_not_found")

        missing_search = self.client.post(
            "/index/v1/search",
            json={"workspaceKey": "missing-workspace", "query": "login", "limit": 5},
        )
        self.assertEqual(missing_search.status_code, 404)
        self.assertEqual(
            missing_search.json()["errorCode"],
            "knowledge_workspace_not_found",
        )

        missing_embeddings = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(workspace_key="missing-workspace"),
        )
        self.assertEqual(missing_embeddings.status_code, 404)
        self.assertEqual(
            missing_embeddings.json()["errorCode"],
            "knowledge_workspace_not_found",
        )

    def test_reports_when_the_optional_knowledge_store_is_unavailable(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            application = create_app(
                chat_provider=UnusedProvider(),
                backend_token_provider=lambda: self.backend_token,
            )
        with TestClient(
            application,
            headers={DEVMATE_BACKEND_TOKEN_HEADER: self.backend_token},
        ) as client:
            response = client.post(
                "/index/v1/workspaces/open",
                json={
                    "workspaceKey": "workspace-one",
                    "rootPath": str(self.workspace_root),
                    "chunkingVersion": 1,
                },
            )
            embedding_response = client.post(
                "/index/v1/embeddings/synchronize",
                json=self._embedding_request(),
            )
            semantic_response = client.post(
                "/index/v1/embeddings/search",
                json=self._semantic_search_request(),
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {
            "status": "error",
            "errorCode": "knowledge_store_unavailable",
            "message": "The local DevMate knowledge store is unavailable.",
            "issues": [],
        })

        self.assertEqual(embedding_response.status_code, 503)
        self.assertEqual(
            embedding_response.json()["errorCode"],
            "knowledge_store_unavailable",
        )
        self.assertEqual(semantic_response.status_code, 503)
        self.assertEqual(
            semantic_response.json()["errorCode"],
            "knowledge_store_unavailable",
        )

    def test_synchronizes_embeddings_without_echoing_provider_credentials(self) -> None:
        self._open_workspace()
        self._apply_indexed_file()

        response = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(batch_size=1, max_batches=1),
            headers={"X-DevMate-Provider-Key": "embedding-secret"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "ok",
            "data": {
                "configuration": {
                    "profileId": "local-embedding",
                    "provider": "ollama",
                    "model": "nomic-embed-text",
                    "dimensions": 2,
                    "vectorVersion": 1,
                },
                "embeddedChunks": 1,
                "processedBatches": 1,
                "complete": True,
            },
        })
        provider_request = self.embedding_provider.requests[0]
        self.assertEqual(provider_request.api_key, "embedding-secret")
        self.assertEqual(
            provider_request.inputs,
            ("def validate_login_token(token): return bool(token)",),
        )
        self.assertNotIn("embedding-secret", response.text)

        repeated = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(),
        )
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["data"]["embeddedChunks"], 0)
        self.assertEqual(repeated.json()["data"]["processedBatches"], 0)
        self.assertTrue(repeated.json()["data"]["complete"])
        self.assertEqual(len(self.embedding_provider.requests), 1)

    def test_semantically_searches_cached_vectors_without_echoing_credentials(self) -> None:
        self._open_workspace()
        self._apply_indexed_file()
        synchronized = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(),
        )
        self.assertEqual(synchronized.status_code, 200)

        response = self.client.post(
            "/index/v1/embeddings/search",
            json=self._semantic_search_request(),
            headers={"X-DevMate-Provider-Key": "semantic-query-secret"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "ok",
            "data": {
                "configuration": {
                    "profileId": "local-embedding",
                    "provider": "ollama",
                    "model": "nomic-embed-text",
                    "dimensions": 2,
                    "vectorVersion": 1,
                },
                "results": [{
                    "relativePath": "src/auth.py",
                    "languageId": "python",
                    "stableId": "src/auth.py:1-2",
                    "ordinal": 0,
                    "startLine": 1,
                    "endLine": 2,
                    "content": "def validate_login_token(token): return bool(token)",
                    "contentHash": "chunk-auth-hash",
                    "score": 1.0,
                }],
            },
        })
        query_request = self.embedding_provider.requests[-1]
        self.assertEqual(query_request.inputs, ("session credential checks",))
        self.assertEqual(query_request.api_key, "semantic-query-secret")
        self.assertNotIn("semantic-query-secret", response.text)

    def test_semantic_search_returns_empty_before_vectors_are_available(self) -> None:
        self._open_workspace()
        self._apply_indexed_file()

        response = self.client.post(
            "/index/v1/embeddings/search",
            json=self._semantic_search_request(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"], {
            "configuration": None,
            "results": [],
        })
        self.assertEqual(self.embedding_provider.requests, [])

    def test_rejects_invalid_embedding_contracts_before_provider_access(self) -> None:
        self._open_workspace()
        self._apply_indexed_file()
        invalid_requests = (
            {**self._embedding_request(), "apiKey": "must-not-be-in-json"},
            {**self._embedding_request(), "provider": "unsupported"},
            {**self._embedding_request(), "profileId": "invalid profile"},
            {**self._embedding_request(), "batchSize": 65},
            {**self._embedding_request(), "maxBatches": 17},
        )

        for payload in invalid_requests:
            with self.subTest(payload=payload):
                response = self.client.post(
                    "/index/v1/embeddings/synchronize",
                    json=payload,
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json()["errorCode"],
                    "request_validation_failed",
                )

        oversized_key = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(),
            headers={"X-DevMate-Provider-Key": "s" * 8_193},
        )
        self.assertEqual(oversized_key.status_code, 422)
        self.assertEqual(
            oversized_key.json()["errorCode"],
            "request_validation_failed",
        )
        self.assertEqual(self.embedding_provider.requests, [])

        invalid_semantic_requests = (
            {**self._semantic_search_request(), "apiKey": "must-not-be-in-json"},
            {**self._semantic_search_request(), "query": ""},
            {**self._semantic_search_request(), "limit": 101},
        )
        for payload in invalid_semantic_requests:
            with self.subTest(payload=payload):
                response = self.client.post(
                    "/index/v1/embeddings/search",
                    json=payload,
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json()["errorCode"],
                    "request_validation_failed",
                )
        self.assertEqual(self.embedding_provider.requests, [])

    def test_maps_embedding_provider_and_batch_failures_to_stable_errors(self) -> None:
        self._open_workspace()
        self._apply_indexed_file()
        self.embedding_provider.error = ProviderError(
            "The embedding provider is busy.",
            429,
        )

        provider_failure = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(),
        )
        self.assertEqual(provider_failure.status_code, 429)
        self.assertEqual(
            provider_failure.json()["errorCode"],
            "provider_rate_limited",
        )

        self.embedding_provider.error = None
        self.embedding_provider.return_malformed_batch = True
        malformed = self.client.post(
            "/index/v1/embeddings/synchronize",
            json=self._embedding_request(),
        )
        self.assertEqual(malformed.status_code, 502)
        self.assertEqual(
            malformed.json()["errorCode"],
            "provider_invalid_response",
        )
        self.assertNotIn("wrong number", malformed.text)

    def test_composes_the_default_embedding_service_with_the_private_store(self) -> None:
        application = create_app(
            chat_provider=UnusedProvider(),
            backend_token_provider=lambda: self.backend_token,
            knowledge_store=self.store,
        )

        dependencies = application.state.devmate_dependencies
        self.assertIsInstance(
            dependencies.embedding_index_service,
            EmbeddingIndexService,
        )
        self.assertIsInstance(
            dependencies.semantic_search_service,
            SemanticSearchService,
        )

    def _open_workspace(self):
        return self.client.post(
            "/index/v1/workspaces/open",
            json={
                "workspaceKey": "workspace-one",
                "rootPath": str(self.workspace_root),
                "chunkingVersion": 1,
            },
        )

    def _apply_indexed_file(self):
        return self.client.post(
            "/index/v1/files/apply",
            json={
                "workspaceKey": "workspace-one",
                "upserts": [self._indexed_file()],
                "deletedPaths": [],
            },
        )

    @staticmethod
    def _embedding_request(
        *,
        workspace_key: str = "workspace-one",
        batch_size: int = 64,
        max_batches: int = 1,
    ) -> dict[str, object]:
        return {
            "workspaceKey": workspace_key,
            "profileId": "local-embedding",
            "provider": "ollama",
            "model": "nomic-embed-text",
            "baseUrl": "http://127.0.0.1:11434",
            "remoteAllowed": False,
            "vectorVersion": 1,
            "batchSize": batch_size,
            "maxBatches": max_batches,
        }

    @staticmethod
    def _semantic_search_request() -> dict[str, object]:
        return {
            "workspaceKey": "workspace-one",
            "query": "session credential checks",
            "profileId": "local-embedding",
            "provider": "ollama",
            "model": "nomic-embed-text",
            "baseUrl": "http://127.0.0.1:11434",
            "remoteAllowed": False,
            "vectorVersion": 1,
            "limit": 5,
        }

    @staticmethod
    def _indexed_file() -> dict[str, object]:
        return {
            "relativePath": "src/auth.py",
            "languageId": "python",
            "contentHash": "file-auth-hash",
            "sizeBytes": 72,
            "modifiedAt": 100,
            "chunks": [{
                "stableId": "src/auth.py:1-2",
                "ordinal": 0,
                "startLine": 1,
                "endLine": 2,
                "content": "def validate_login_token(token): return bool(token)",
                "contentHash": "chunk-auth-hash",
                "chunkingVersion": 1,
            }],
        }


if __name__ == "__main__":
    unittest.main()
