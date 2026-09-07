import shutil
import unittest
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from backend.app.memory.chat_memory_repository import (
    ChatDecision,
    ChatMemoryNotFoundError,
    ChatMemoryRepository,
    ChatMemoryRepositoryError,
    ChatMemoryValidationError,
    ChatSessionRecord,
    ChatSessionSnapshot,
    ChatSummaryContent,
    ChatTurnRecord,
)
from backend.app.indexing.knowledge_repository import KnowledgeRepository
from backend.app.knowledge_store import KnowledgeStore


class ChatMemoryRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(
            self.temporary_directory / "devmate.sqlite3"
        ).open()
        self.repository = ChatMemoryRepository(self.store)

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    def test_replacing_snapshots_completes_and_appends_turns_without_losing_history(self) -> None:
        snapshot = self._snapshot(
            "session-one",
            turns=(
                ChatTurnRecord(
                    ordinal=0,
                    user="Change the greeting",
                    assistant="I changed it.",
                    file_changes_json='[ {"path":"src/app.ts","kind":"update"} ]',
                ),
                ChatTurnRecord(ordinal=1, user="Now test it", assistant=""),
            ),
        )

        saved = self.repository.save_session(snapshot)
        completed = replace(saved.turns[1], assistant="All tests pass.")
        updated = self.repository.save_session(ChatSessionSnapshot(
            session=replace(saved.session, updated_at_ms=300),
            turns=(saved.turns[0], completed),
        ))
        appended = ChatTurnRecord(ordinal=2, user="Explain the result", assistant="")
        self.repository.save_session(ChatSessionSnapshot(
            session=replace(updated.session, updated_at_ms=400),
            turns=(*updated.turns, appended),
        ))
        loaded = self.repository.load_session("session-one")

        self.assertEqual(
            saved.turns[0].file_changes_json,
            '[{"path":"src/app.ts","kind":"update"}]',
        )
        self.assertEqual(completed.ordinal, 1)
        self.assertEqual(completed.assistant, "All tests pass.")
        self.assertEqual(appended.ordinal, 2)
        self.assertEqual(loaded.session.updated_at_ms, 400)
        self.assertEqual(loaded.turns, (
            saved.turns[0],
            completed,
            appended,
        ))

    def test_lists_only_the_requested_workspace_in_recent_order(self) -> None:
        self.repository.save_session(self._snapshot(
            "session-older",
            workspace_identity="file:///workspace-one",
            updated_at_ms=100,
        ))
        self.repository.save_session(self._snapshot(
            "session-newer",
            workspace_identity="file:///workspace-one",
            updated_at_ms=300,
        ))
        self.repository.save_session(self._snapshot(
            "session-other",
            workspace_identity="file:///workspace-two",
            updated_at_ms=400,
        ))

        sessions = self.repository.list_sessions("file:///workspace-one")

        self.assertEqual(
            [session.session_id for session in sessions],
            ["session-newer", "session-older"],
        )
        self.assertEqual(
            self.repository.list_sessions("file:///workspace-one", limit=1)[0].session_id,
            "session-newer",
        )

    def test_saves_a_validated_summary_without_removing_raw_turns(self) -> None:
        self.repository.save_session(self._snapshot(
            "session-one",
            turns=(
                ChatTurnRecord(0, "Plan the feature", "Here is the plan."),
                ChatTurnRecord(1, "Implement it", "Implementation finished."),
            ),
        ))
        content = ChatSummaryContent(
            goal="Add compact chat memory.",
            constraints=("Keep raw turns.",),
            decisions=(ChatDecision("Use SQLite.", "It is local and transactional."),),
            important_files=("src/sessions.ts",),
            completed_work=("Added the schema.",),
            open_tasks=("Connect the extension.",),
            unresolved_questions=("When should compaction run?",),
        )

        saved = self.repository.save_summary(
            "session-one",
            content,
            last_compacted_turn=0,
            updated_at_ms=300,
        )

        self.assertEqual(self.repository.load_summary("session-one"), saved)
        self.assertEqual(len(self.repository.load_session("session-one").turns), 2)
        with self.assertRaisesRegex(ChatMemoryValidationError, "cannot move backwards"):
            self.repository.save_summary(
                "session-one",
                content,
                last_compacted_turn=0,
                updated_at_ms=299,
            )

    def test_chat_and_code_index_lifecycles_are_independent(self) -> None:
        knowledge_repository = KnowledgeRepository(self.store)
        knowledge_repository.register_workspace(
            "workspace-one",
            str(self.temporary_directory / "workspace"),
            chunking_version=1,
        )
        self.repository.save_session(self._snapshot(
            "session-one",
            workspace_identity="workspace-one",
            turns=(ChatTurnRecord(0, "Question", "Answer"),),
        ))
        self.repository.save_summary(
            "session-one",
            ChatSummaryContent(goal="Keep the history."),
            last_compacted_turn=0,
            updated_at_ms=300,
        )
        self.assertTrue(knowledge_repository.delete_workspace("workspace-one"))
        self.assertIsNotNone(self.repository.load_session("session-one"))
        self.assertTrue(self.repository.delete_session("session-one"))
        self.assertIsNone(self.repository.load_session("session-one"))
        for table in ("chat_turns", "chat_summaries"):
            self.assertEqual(
                self.store.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0],
                0,
            )

    def test_session_replacement_rolls_back_as_one_transaction(self) -> None:
        original = self._snapshot(
            "session-one",
            title="Original",
            turns=(ChatTurnRecord(0, "Original question", "Original answer"),),
        )
        self.repository.save_session(original)
        self.store.connection.execute(
            """
            CREATE TRIGGER reject_chat_turn BEFORE INSERT ON chat_turns
            WHEN new.user_text = 'reject transaction'
            BEGIN
                SELECT RAISE(ABORT, 'rejected by test');
            END
            """
        )
        replacement = self._snapshot(
            "session-one",
            title="Replacement",
            updated_at_ms=300,
            turns=(
                ChatTurnRecord(0, "New question", "New answer"),
                ChatTurnRecord(1, "reject transaction", "Never stored"),
            ),
        )

        with self.assertRaisesRegex(ChatMemoryRepositoryError, "could not be saved"):
            self.repository.save_session(replacement)

        self.assertEqual(self.repository.load_session("session-one"), original)

    def test_rejects_invalid_or_ambiguous_memory_operations(self) -> None:
        with self.assertRaisesRegex(ChatMemoryValidationError, "contiguous"):
            self.repository.save_session(self._snapshot(
                "session-one",
                turns=(ChatTurnRecord(1, "Question", "Answer"),),
            ))
        self.repository.save_session(self._snapshot(
            "session-one",
            turns=(ChatTurnRecord(0, "Pending question", ""),),
        ))
        with self.assertRaisesRegex(ChatMemoryValidationError, "completed turn"):
            self.repository.save_summary(
                "session-one",
                ChatSummaryContent(goal="Invalid summary"),
                last_compacted_turn=0,
                updated_at_ms=300,
            )
        before_invalid_save = self.repository.load_session("session-one")
        with self.assertRaisesRegex(ChatMemoryValidationError, "JSON"):
            self.repository.save_session(self._snapshot(
                "session-one",
                turns=(ChatTurnRecord(0, "Question", "", file_changes_json="{}"),),
            ))
        self.assertEqual(self.repository.load_session("session-one"), before_invalid_save)
        with self.assertRaisesRegex(ChatMemoryNotFoundError, "does not exist"):
            self.repository.save_summary(
                "missing-session",
                ChatSummaryContent(goal="Cannot summarize a missing session"),
                last_compacted_turn=0,
                updated_at_ms=300,
            )

    @staticmethod
    def _snapshot(
        session_id: str,
        *,
        workspace_identity: str = "file:///workspace-one",
        title: str = "Session",
        updated_at_ms: int = 200,
        turns: tuple[ChatTurnRecord, ...] = (),
    ) -> ChatSessionSnapshot:
        return ChatSessionSnapshot(
            session=ChatSessionRecord(
                session_id=session_id,
                workspace_identity=workspace_identity,
                workspace_name="Workspace",
                title=title,
                created_at_ms=100,
                updated_at_ms=updated_at_ms,
            ),
            turns=turns,
        )


if __name__ == "__main__":
    unittest.main()
