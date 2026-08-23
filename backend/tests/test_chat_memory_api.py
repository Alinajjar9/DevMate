import shutil
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.api_models import DEVMATE_BACKEND_TOKEN_HEADER
from backend.app.main import create_app
from backend.app.providers import ChatCompletion, ChatCompletionRequest
from backend.app.knowledge_store import KnowledgeStore


class UnusedProvider:
    async def complete(self, _request: ChatCompletionRequest) -> ChatCompletion:
        raise AssertionError("Chat-memory API tests must not call the chat provider.")


class ChatMemoryApiTests(unittest.TestCase):
    backend_token = "memory-backend-token-that-is-long-enough"

    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(self.temporary_directory / "memory-api.sqlite3")
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

    def test_authenticates_every_chat_memory_route_before_validation(self) -> None:
        for path in (
            "/memory/v1/sessions/save",
            "/memory/v1/sessions/load",
            "/memory/v1/sessions/list",
            "/memory/v1/sessions/delete",
        ):
            with self.subTest(path=path):
                response = self.client.post(
                    path,
                    json={},
                    headers={DEVMATE_BACKEND_TOKEN_HEADER: "wrong-token"},
                )
                self.assertEqual(response.status_code, 401)
                self.assertEqual(
                    response.json()["errorCode"],
                    "backend_authentication_failed",
                )

    def test_round_trips_lists_and_deletes_strict_session_snapshots(self) -> None:
        first = self._snapshot("session-one", updated_at_ms=200)
        second = self._snapshot("session-two", updated_at_ms=300)

        saved = self.client.post(
            "/memory/v1/sessions/save",
            json={"sessions": [first, second]},
        )
        listed = self.client.post(
            "/memory/v1/sessions/list",
            json={"workspaceIdentity": "file:///workspace-one", "limit": 20},
        )
        loaded = self.client.post(
            "/memory/v1/sessions/load",
            json={"sessionId": "session-one"},
        )
        deleted = self.client.post(
            "/memory/v1/sessions/delete",
            json={"sessionId": "session-one"},
        )

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(
            saved.json()["data"]["savedSessionIds"],
            ["session-one", "session-two"],
        )
        self.assertEqual(
            [item["sessionId"] for item in listed.json()["data"]["sessions"]],
            ["session-two", "session-one"],
        )
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()["data"]["session"], first)
        self.assertEqual(deleted.json()["data"], {"deleted": True})
        missing = self.client.post(
            "/memory/v1/sessions/load",
            json={"sessionId": "session-one"},
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["errorCode"], "chat_session_not_found")

    def test_rejects_unknown_fields_invalid_turn_order_and_bad_file_changes(self) -> None:
        malformed_requests = (
            {"sessions": [dict(self._snapshot("session-one"), unexpected=True)]},
            {"sessions": [{
                **self._snapshot("session-one"),
                "turns": [{
                    **self._snapshot("session-one")["turns"][0],
                    "ordinal": 2,
                }],
            }]},
            {"sessions": [{
                **self._snapshot("session-one"),
                "turns": [{
                    **self._snapshot("session-one")["turns"][0],
                    "fileChanges": [{
                        "kind": "renamed",
                        "path": "src/new.ts",
                    }],
                }],
            }]},
        )
        for request in malformed_requests:
            with self.subTest(request=request):
                response = self.client.post(
                    "/memory/v1/sessions/save",
                    json=request,
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["errorCode"], "request_validation_failed")

        listed = self.client.post(
            "/memory/v1/sessions/list",
            json={"workspaceIdentity": "file:///workspace-one", "limit": 20},
        )
        self.assertEqual(listed.json()["data"]["sessions"], [])

    def test_saves_a_session_batch_as_one_transaction(self) -> None:
        with closing(sqlite3.connect(self.store.database_path)) as connection:
            connection.execute(
                """
                CREATE TRIGGER reject_api_chat_turn BEFORE INSERT ON chat_turns
                WHEN new.user_text = 'reject transaction'
                BEGIN
                    SELECT RAISE(ABORT, 'rejected by test');
                END
                """
            )
        first = self._snapshot("session-one", updated_at_ms=200)
        second = self._snapshot("session-two", updated_at_ms=300)
        second["turns"][0]["user"] = "reject transaction"

        response = self.client.post(
            "/memory/v1/sessions/save",
            json={"sessions": [first, second]},
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["errorCode"], "chat_memory_failure")
        self.assertNotIn("rejected by test", response.text)
        with closing(sqlite3.connect(self.store.database_path)) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM chat_sessions").fetchone()[0],
                0,
            )

    def test_reports_when_chat_memory_storage_is_unavailable(self) -> None:
        application = create_app(
            chat_provider=UnusedProvider(),
            backend_token_provider=lambda: self.backend_token,
        )
        with TestClient(
            application,
            headers={DEVMATE_BACKEND_TOKEN_HEADER: self.backend_token},
        ) as client:
            response = client.post(
                "/memory/v1/sessions/list",
                json={"workspaceIdentity": "file:///workspace-one", "limit": 20},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["errorCode"], "knowledge_store_unavailable")

    @staticmethod
    def _snapshot(session_id: str, *, updated_at_ms: int = 200) -> dict:
        return {
            "session": {
                "sessionId": session_id,
                "workspaceIdentity": "file:///workspace-one",
                "workspaceName": "Workspace One",
                "title": "Chat session",
                "createdAtMs": 100,
                "updatedAtMs": updated_at_ms,
            },
            "turns": [{
                "ordinal": 0,
                "user": "Update the greeting",
                "assistant": "The greeting was updated.",
                "fileChanges": [{
                    "kind": "updated",
                    "path": "src/app.ts",
                    "diffId": "diff-one",
                }],
            }],
        }


if __name__ == "__main__":
    unittest.main()
