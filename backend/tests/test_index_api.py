import os
import shutil
import unittest
from pathlib import Path
from unittest import mock
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.api_models import DEVMATE_BACKEND_TOKEN_HEADER
from backend.app.main import create_app
from backend.app.providers import ChatCompletion, ChatCompletionRequest
from backend.app.knowledge_store import KnowledgeStore


class UnusedProvider:
    async def complete(self, _request: ChatCompletionRequest) -> ChatCompletion:
        raise AssertionError("Index API tests must not call the chat provider.")


class KnowledgeIndexApiTests(unittest.TestCase):
    backend_token = "index-backend-token-that-is-long-enough"

    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.workspace_root = self.temporary_directory / "workspace"
        self.store = KnowledgeStore(self.temporary_directory / "index-api.sqlite3")
        self.application = create_app(
            chat_provider=UnusedProvider(),
            backend_token_provider=lambda: self.backend_token,
            knowledge_store=self.store,
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

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {
            "status": "error",
            "errorCode": "knowledge_store_unavailable",
            "message": "The local DevMate knowledge store is unavailable.",
            "issues": [],
        })

    def _open_workspace(self):
        return self.client.post(
            "/index/v1/workspaces/open",
            json={
                "workspaceKey": "workspace-one",
                "rootPath": str(self.workspace_root),
                "chunkingVersion": 1,
            },
        )

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
