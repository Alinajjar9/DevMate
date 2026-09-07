import json
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.api.api_models import LlmSettings
from backend.app.memory.chat_compaction_service import (
    ChatCompactionBoundaryError,
    ChatCompactionModelError,
    ChatCompactionService,
)
from backend.app.memory.chat_memory_repository import (
    ChatMemoryRepository,
    ChatSessionRecord,
    ChatSessionSnapshot,
    ChatTurnRecord,
)
from backend.app.knowledge_store import KnowledgeStore
from backend.app.providers.chat_provider import ChatCompletion, ChatCompletionRequest
from backend.app.providers.provider_network import ProviderError


class RecordingProvider:
    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.error: ProviderError | None = None
        self.requests: list[ChatCompletionRequest] = []

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.answer if isinstance(self.answer, ChatCompletion) else ChatCompletion(content=self.answer)


class ChatCompactionServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(
            self.temporary_directory / "compaction.sqlite3"
        ).open()
        self.repository = ChatMemoryRepository(self.store)
        self.repository.save_session(self._snapshot())
        self.provider = RecordingProvider(self._summary_json(goal="Initial goal"))
        self.service = ChatCompactionService(
            self.repository,
            clock_ms=lambda: 500,
        )

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    async def test_merges_the_previous_summary_with_only_new_eligible_turns(self) -> None:
        first, first_count = await self.service.compact(
            "session-one",
            0,
            self._settings(),
            self.provider,
            "  provider-secret  ",
        )
        self.provider.answer = self._summary_json(goal="Updated goal")

        second, second_count = await self.service.compact(
            "session-one",
            1,
            self._settings(),
            self.provider,
            "provider-secret",
        )

        second_payload = json.loads(self.provider.requests[1].messages[1].content)
        self.assertEqual(first_count, 1)
        self.assertEqual(second_count, 1)
        self.assertEqual(first.last_compacted_turn, 0)
        self.assertEqual(second.last_compacted_turn, 1)
        self.assertEqual(second.content.goal, "Updated goal")
        self.assertEqual(second_payload["previousSummary"]["goal"], "Initial goal")
        self.assertEqual(
            [turn["ordinal"] for turn in second_payload["newTurns"]],
            [1],
        )
        request = self.provider.requests[0]
        self.assertEqual(request.api_key, "provider-secret")
        self.assertEqual(request.max_tokens, 4_096)
        self.assertEqual(request.temperature, 0.2)
        self.assertTrue(request.force_final_answer)
        self.assertTrue(request.disable_thinking)
        self.assertEqual(len(self.repository.load_session("session-one").turns), 3)

    async def test_invalid_model_output_preserves_the_previous_summary(self) -> None:
        previous, _ = await self.service.compact(
            "session-one",
            0,
            self._settings(),
            self.provider,
            None,
        )
        self.provider.answer = '{"goal":"missing fields"}'

        with self.assertRaises(ChatCompactionModelError):
            await self.service.compact(
                "session-one",
                1,
                self._settings(),
                self.provider,
                None,
            )

        self.assertEqual(self.repository.load_summary("session-one"), previous)

    async def test_provider_failure_preserves_the_previous_summary(self) -> None:
        previous, _ = await self.service.compact(
            "session-one",
            0,
            self._settings(),
            self.provider,
            None,
        )
        self.provider.error = ProviderError("Provider unavailable", 503)

        with self.assertRaises(ProviderError):
            await self.service.compact(
                "session-one",
                1,
                self._settings(),
                self.provider,
                None,
            )

        self.assertEqual(self.repository.load_summary("session-one"), previous)

    async def test_redacts_secret_patterns_before_saving_generated_memory(self) -> None:
        self.provider.answer = self._summary_json(
            goal="Use api_key=supersecret123456 for requests",
            constraint="Bearer abcdefghijklmnopqrstuvwxyz",
            decision="Keep sk-secretvalue123456789",
        )

        summary, _ = await self.service.compact(
            "session-one",
            0,
            self._settings(),
            self.provider,
            None,
        )

        serialized = repr(summary.content)
        self.assertNotIn("supersecret", serialized)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", serialized)
        self.assertNotIn("secretvalue", serialized)
        self.assertIn("REDACTED", serialized)

    async def test_rejects_pending_repeated_and_oversized_compaction_ranges(self) -> None:
        with self.assertRaisesRegex(ChatCompactionBoundaryError, "completed"):
            await self.service.compact(
                "session-one",
                2,
                self._settings(),
                self.provider,
                None,
            )
        await self.service.compact(
            "session-one",
            0,
            self._settings(),
            self.provider,
            None,
        )
        with self.assertRaisesRegex(ChatCompactionBoundaryError, "new chat turns"):
            await self.service.compact(
                "session-one",
                0,
                self._settings(),
                self.provider,
                None,
            )

        oversized_turns = tuple(
            ChatTurnRecord(index, "u" * 6_000, "a" * 6_000)
            for index in range(14)
        )
        self.repository.save_session(self._snapshot(
            session_id="session-large",
            turns=oversized_turns,
        ))
        with self.assertRaisesRegex(ChatCompactionBoundaryError, "too large"):
            await self.service.compact(
                "session-large",
                len(oversized_turns) - 1,
                self._settings(),
                self.provider,
                None,
            )

    @staticmethod
    def _settings() -> LlmSettings:
        return LlmSettings.model_validate({
            "provider": "openai",
            "model": "test-model",
            "baseUrl": "https://example.com/v1",
            "maxTokens": 8_000,
            "temperature": 0.8,
            "reasoningEffort": "medium",
            "timeoutSeconds": 120,
        })

    @staticmethod
    def _snapshot(
        *,
        session_id: str = "session-one",
        turns: tuple[ChatTurnRecord, ...] | None = None,
    ) -> ChatSessionSnapshot:
        return ChatSessionSnapshot(
            session=ChatSessionRecord(
                session_id=session_id,
                workspace_identity="file:///workspace-one",
                workspace_name="Workspace One",
                title="Compaction test",
                created_at_ms=100,
                updated_at_ms=300,
            ),
            turns=turns or (
                ChatTurnRecord(0, "Plan the work", "Here is the plan."),
                ChatTurnRecord(1, "Implement it", "Implementation finished."),
                ChatTurnRecord(2, "Now verify", ""),
            ),
        )

    @staticmethod
    def _summary_json(
        *,
        goal: str,
        constraint: str = "Keep raw turns.",
        decision: str = "Use structured memory.",
    ) -> str:
        return json.dumps({
            "goal": goal,
            "constraints": [constraint],
            "decisions": [{
                "decision": decision,
                "reason": "It is validated before storage.",
            }],
            "importantFiles": ["src/contextPlanner.ts"],
            "completedWork": ["Added chat storage."],
            "openTasks": ["Connect compaction."],
            "unresolvedQuestions": ["When should it run?"],
        })


if __name__ == "__main__":
    unittest.main()
