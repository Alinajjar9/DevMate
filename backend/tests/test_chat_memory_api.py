import shutil
import sqlite3
import unittest
import json
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.api_models import DEVMATE_BACKEND_TOKEN_HEADER
from backend.app.main import create_app
from backend.app.providers import ChatCompletion, ChatCompletionRequest
from backend.app.knowledge_store import KnowledgeStore


class ControlledProvider:
    def __init__(self) -> None:
        self.enabled = False
        self.answer = ""
        self.requests: list[ChatCompletionRequest] = []

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        if not self.enabled:
            raise AssertionError("Chat-memory storage routes must not call the chat provider.")
        self.requests.append(request)
        return ChatCompletion(content=self.answer)


class ChatMemoryApiTests(unittest.TestCase):
    backend_token = "memory-backend-token-that-is-long-enough"

    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(self.temporary_directory / "memory-api.sqlite3")
        self.provider = ControlledProvider()
        self.application = create_app(
            chat_provider=self.provider,
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
            "/memory/v1/summaries/save",
            "/memory/v1/summaries/load",
            "/memory/v1/summaries/clear",
            "/memory/v1/summaries/compact",
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

    def test_round_trips_and_clears_a_strict_summary_without_removing_turns(self) -> None:
        snapshot = self._snapshot("session-one")
        self.client.post("/memory/v1/sessions/save", json={"sessions": [snapshot]})
        missing = self.client.post(
            "/memory/v1/summaries/load",
            json={"sessionId": "session-one"},
        )

        saved = self.client.post(
            "/memory/v1/summaries/save",
            json={
                "sessionId": "session-one",
                "content": self._summary_content(),
                "lastCompactedTurn": 0,
                "updatedAtMs": 300,
            },
        )
        loaded = self.client.post(
            "/memory/v1/summaries/load",
            json={"sessionId": "session-one"},
        )
        cleared = self.client.post(
            "/memory/v1/summaries/clear",
            json={"sessionId": "session-one"},
        )
        session = self.client.post(
            "/memory/v1/sessions/load",
            json={"sessionId": "session-one"},
        )

        self.assertEqual(missing.json()["data"], {"summary": None})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["data"]["summary"], {
            "sessionId": "session-one",
            "summaryVersion": 1,
            "content": self._summary_content(),
            "lastCompactedTurn": 0,
            "createdAtMs": 300,
            "updatedAtMs": 300,
        })
        self.assertEqual(loaded.json(), saved.json())
        self.assertEqual(cleared.json()["data"], {"cleared": True})
        self.assertEqual(session.json()["data"]["session"]["turns"], snapshot["turns"])

    def test_rejects_invalid_summary_content_and_non_completed_boundaries(self) -> None:
        snapshot = self._snapshot("session-one")
        self.client.post("/memory/v1/sessions/save", json={"sessions": [snapshot]})
        invalid_requests = (
            {
                "sessionId": "session-one",
                "content": {**self._summary_content(), "unexpected": True},
                "lastCompactedTurn": 0,
                "updatedAtMs": 300,
            },
            {
                "sessionId": "session-one",
                "content": {**self._summary_content(), "goal": ""},
                "lastCompactedTurn": 0,
                "updatedAtMs": 300,
            },
            {
                "sessionId": "session-one",
                "content": self._summary_content(),
                "lastCompactedTurn": 1,
                "updatedAtMs": 300,
            },
        )
        for request in invalid_requests:
            with self.subTest(request=request):
                response = self.client.post("/memory/v1/summaries/save", json=request)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["errorCode"], "request_validation_failed")

        loaded = self.client.post(
            "/memory/v1/summaries/load",
            json={"sessionId": "session-one"},
        )
        self.assertEqual(loaded.json()["data"], {"summary": None})

    def test_compacts_with_the_active_provider_and_strict_summary_contract(self) -> None:
        self.client.post(
            "/memory/v1/sessions/save",
            json={"sessions": [self._snapshot("session-one")]},
        )
        self.provider.enabled = True
        self.provider.answer = json.dumps(self._summary_content())

        response = self.client.post(
            "/memory/v1/summaries/compact",
            json={
                "sessionId": "session-one",
                "throughTurn": 0,
                "settings": {
                    "provider": "openai",
                    "model": "test-model",
                    "baseUrl": "https://example.com/v1",
                    "maxTokens": 8_000,
                    "temperature": 0.7,
                    "reasoningEffort": "medium",
                    "timeoutSeconds": 120,
                },
            },
            headers={"X-DevMate-Provider-Key": "compaction-provider-secret"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["compactedTurns"], 1)
        self.assertEqual(
            response.json()["data"]["summary"]["content"],
            self._summary_content(),
        )
        self.assertEqual(
            response.json()["data"]["summary"]["lastCompactedTurn"],
            0,
        )
        self.assertEqual(self.provider.requests[0].api_key, "compaction-provider-secret")
        self.assertTrue(self.provider.requests[0].force_final_answer)

    def test_rejects_invalid_generated_summary_without_replacing_memory(self) -> None:
        snapshot = self._snapshot("session-one")
        snapshot["turns"].append({
            "ordinal": 1,
            "user": "Continue the implementation",
            "assistant": "The next step is complete.",
            "fileChanges": [],
        })
        self.client.post(
            "/memory/v1/sessions/save",
            json={"sessions": [snapshot]},
        )
        existing = self.client.post(
            "/memory/v1/summaries/save",
            json={
                "sessionId": "session-one",
                "content": self._summary_content(),
                "lastCompactedTurn": 0,
                "updatedAtMs": 300,
            },
        ).json()["data"]["summary"]
        self.provider.enabled = True
        self.provider.answer = '{"goal":"missing fields"}'

        response = self.client.post(
            "/memory/v1/summaries/compact",
            json={
                "sessionId": "session-one",
                "throughTurn": 1,
                "settings": {
                    "provider": "ollama",
                    "model": "local-model",
                    "maxTokens": 2_000,
                    "temperature": 0.2,
                    "timeoutSeconds": 120,
                },
            },
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["errorCode"], "model_invalid_response")
        loaded = self.client.post(
            "/memory/v1/summaries/load",
            json={"sessionId": "session-one"},
        )
        self.assertEqual(loaded.json()["data"]["summary"], existing)

    def test_reports_when_chat_memory_storage_is_unavailable(self) -> None:
        application = create_app(
            chat_provider=ControlledProvider(),
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

    @staticmethod
    def _summary_content() -> dict:
        return {
            "goal": "Keep useful chat context compact.",
            "constraints": ["Keep raw turns."],
            "decisions": [{
                "decision": "Use structured summaries.",
                "reason": "They can be validated before storage.",
            }],
            "importantFiles": ["src/contextPlanner.ts"],
            "completedWork": ["Added SQLite chat storage."],
            "openTasks": ["Generate summaries."],
            "unresolvedQuestions": ["When should compaction run?"],
        }


if __name__ == "__main__":
    unittest.main()
