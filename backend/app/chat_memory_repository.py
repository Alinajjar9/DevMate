from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass

from .chat_memory_contracts import (
    CHAT_SUMMARY_VERSION,
    MAX_CHAT_FILE_CHANGES_JSON_CHARACTERS,
    MAX_CHAT_SESSIONS_PER_REQUEST,
    MAX_CHAT_SESSIONS_RETURNED,
    MAX_CHAT_SESSION_ID_CHARACTERS,
    MAX_CHAT_SESSION_TITLE_CHARACTERS,
    MAX_CHAT_SUMMARY_CHARACTERS,
    MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
    MAX_CHAT_SUMMARY_ITEMS,
    MAX_CHAT_TURNS_PER_SNAPSHOT,
    MAX_CHAT_TURN_CHARACTERS,
    MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
    MAX_CHAT_WORKSPACE_NAME_CHARACTERS,
    MAX_PINNED_MEMORIES,
    MAX_PINNED_MEMORY_CHARACTERS,
)
from .knowledge_store import KnowledgeStore


_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$")
_SUMMARY_FIELDS = (
    "constraints",
    "important_files",
    "completed_work",
    "open_tasks",
    "unresolved_questions",
)


class ChatMemoryRepositoryError(RuntimeError):
    """Raised when durable chat memory cannot be read or written."""


class ChatMemoryValidationError(ChatMemoryRepositoryError):
    """Raised when chat-memory input violates its bounded local contract."""


class ChatMemoryNotFoundError(ChatMemoryRepositoryError):
    """Raised when a chat-memory operation targets an unknown record."""


@dataclass(frozen=True, slots=True)
class ChatTurnRecord:
    ordinal: int
    user: str
    assistant: str
    file_changes_json: str = "[]"


@dataclass(frozen=True, slots=True)
class ChatSessionRecord:
    session_id: str
    workspace_identity: str
    workspace_name: str
    title: str
    created_at_ms: int
    updated_at_ms: int


@dataclass(frozen=True, slots=True)
class ChatSessionSnapshot:
    session: ChatSessionRecord
    turns: tuple[ChatTurnRecord, ...]


@dataclass(frozen=True, slots=True)
class ChatDecision:
    decision: str
    reason: str


@dataclass(frozen=True, slots=True)
class ChatSummaryContent:
    goal: str
    constraints: tuple[str, ...] = ()
    decisions: tuple[ChatDecision, ...] = ()
    important_files: tuple[str, ...] = ()
    completed_work: tuple[str, ...] = ()
    open_tasks: tuple[str, ...] = ()
    unresolved_questions: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ChatSummaryRecord:
    session_id: str
    content: ChatSummaryContent
    last_compacted_turn: int
    created_at_ms: int
    updated_at_ms: int


@dataclass(frozen=True, slots=True)
class PinnedMemoryRecord:
    session_id: str
    memory_id: str
    content: str
    created_at_ms: int
    updated_at_ms: int


class ChatMemoryRepository:
    """Provides bounded, transactional access to session-scoped chat memory."""

    def __init__(self, store: KnowledgeStore) -> None:
        self._store = store

    def save_session(self, snapshot: ChatSessionSnapshot) -> ChatSessionSnapshot:
        return self.save_sessions((snapshot,))[0]

    def save_sessions(
        self,
        snapshots: Sequence[ChatSessionSnapshot],
    ) -> tuple[ChatSessionSnapshot, ...]:
        if (
            not isinstance(snapshots, Sequence)
            or isinstance(snapshots, (str, bytes))
            or not 1 <= len(snapshots) <= MAX_CHAT_SESSIONS_PER_REQUEST
        ):
            raise ChatMemoryValidationError("The chat-session batch is invalid.")
        validated = tuple(_validated_snapshot(snapshot) for snapshot in snapshots)
        session_ids = [snapshot.session.session_id for snapshot in validated]
        if len(set(session_ids)) != len(session_ids):
            raise ChatMemoryValidationError(
                "Chat-session identifiers must be unique within a batch."
            )
        try:
            with self._store.transaction() as connection:
                for snapshot in validated:
                    self._save_snapshot(connection, snapshot)
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat sessions could not be saved.") from error
        return validated

    def load_session(self, session_id: str) -> ChatSessionSnapshot | None:
        validated_id = _identifier(session_id, "session identifier")
        session_row = self._store.connection.execute(
            """
            SELECT
                session_id,
                workspace_identity,
                workspace_name,
                title,
                created_at_ms,
                updated_at_ms
            FROM chat_sessions
            WHERE session_id = ?
            """,
            (validated_id,),
        ).fetchone()
        if session_row is None:
            return None
        turn_rows = self._store.connection.execute(
            """
            SELECT ordinal, user_text, assistant_text, file_changes_json
            FROM chat_turns
            WHERE session_id = ?
            ORDER BY ordinal
            """,
            (validated_id,),
        ).fetchall()
        return ChatSessionSnapshot(
            session=_session_from_row(session_row),
            turns=tuple(_turn_from_row(row) for row in turn_rows),
        )

    def list_sessions(
        self,
        workspace_identity: str,
        *,
        limit: int = 20,
    ) -> tuple[ChatSessionRecord, ...]:
        validated_workspace = _bounded_identifier_text(
            workspace_identity,
            "workspace identity",
            MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
        )
        validated_limit = _bounded_integer(
            limit,
            "session limit",
            minimum=1,
            maximum=MAX_CHAT_SESSIONS_RETURNED,
        )
        rows = self._store.connection.execute(
            """
            SELECT
                session_id,
                workspace_identity,
                workspace_name,
                title,
                created_at_ms,
                updated_at_ms
            FROM chat_sessions
            WHERE workspace_identity = ?
            ORDER BY updated_at_ms DESC, session_id
            LIMIT ?
            """,
            (validated_workspace, validated_limit),
        ).fetchall()
        return tuple(_session_from_row(row) for row in rows)

    def append_turn(
        self,
        session_id: str,
        *,
        user: str,
        assistant: str = "",
        file_changes_json: str = "[]",
        updated_at_ms: int,
    ) -> ChatTurnRecord:
        validated_id = _identifier(session_id, "session identifier")
        validated_user = _turn_text(user, "user message", allow_empty=False)
        validated_assistant = _turn_text(
            assistant,
            "assistant message",
            allow_empty=True,
        )
        validated_changes = _file_changes_json(file_changes_json)
        validated_updated_at = _timestamp(updated_at_ms, "session update time")
        try:
            with self._store.transaction() as connection:
                session_row = self._required_session(connection, validated_id)
                if validated_updated_at < int(session_row["updated_at_ms"]):
                    raise ChatMemoryValidationError(
                        "The session update time cannot move backwards."
                    )
                ordinal = int(connection.execute(
                    """
                    SELECT COALESCE(MAX(ordinal), -1) + 1
                    FROM chat_turns
                    WHERE session_id = ?
                    """,
                    (validated_id,),
                ).fetchone()[0])
                connection.execute(
                    """
                    INSERT INTO chat_turns(
                        session_id,
                        ordinal,
                        user_text,
                        assistant_text,
                        file_changes_json
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        validated_id,
                        ordinal,
                        validated_user,
                        validated_assistant,
                        validated_changes,
                    ),
                )
                connection.execute(
                    "UPDATE chat_sessions SET updated_at_ms = ? WHERE session_id = ?",
                    (validated_updated_at, validated_id),
                )
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat turn could not be appended.") from error
        return ChatTurnRecord(
            ordinal=ordinal,
            user=validated_user,
            assistant=validated_assistant,
            file_changes_json=validated_changes,
        )

    def complete_turn(
        self,
        session_id: str,
        ordinal: int,
        *,
        assistant: str,
        file_changes_json: str = "[]",
        updated_at_ms: int,
    ) -> ChatTurnRecord:
        validated_id = _identifier(session_id, "session identifier")
        validated_ordinal = _bounded_integer(
            ordinal,
            "turn ordinal",
            minimum=0,
        )
        validated_assistant = _turn_text(
            assistant,
            "assistant message",
            allow_empty=False,
        )
        validated_changes = _file_changes_json(file_changes_json)
        validated_updated_at = _timestamp(updated_at_ms, "session update time")
        try:
            with self._store.transaction() as connection:
                session_row = self._required_session(connection, validated_id)
                if validated_updated_at < int(session_row["updated_at_ms"]):
                    raise ChatMemoryValidationError(
                        "The session update time cannot move backwards."
                    )
                turn_row = connection.execute(
                    """
                    SELECT user_text, assistant_text
                    FROM chat_turns
                    WHERE session_id = ? AND ordinal = ?
                    """,
                    (validated_id, validated_ordinal),
                ).fetchone()
                if turn_row is None:
                    raise ChatMemoryNotFoundError("The chat turn does not exist.")
                if str(turn_row["assistant_text"]):
                    raise ChatMemoryValidationError("The chat turn is already complete.")
                connection.execute(
                    """
                    UPDATE chat_turns
                    SET assistant_text = ?, file_changes_json = ?
                    WHERE session_id = ? AND ordinal = ?
                    """,
                    (
                        validated_assistant,
                        validated_changes,
                        validated_id,
                        validated_ordinal,
                    ),
                )
                connection.execute(
                    "UPDATE chat_sessions SET updated_at_ms = ? WHERE session_id = ?",
                    (validated_updated_at, validated_id),
                )
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat turn could not be completed.") from error
        return ChatTurnRecord(
            ordinal=validated_ordinal,
            user=str(turn_row["user_text"]),
            assistant=validated_assistant,
            file_changes_json=validated_changes,
        )

    def save_summary(
        self,
        session_id: str,
        content: ChatSummaryContent,
        *,
        last_compacted_turn: int,
        updated_at_ms: int,
    ) -> ChatSummaryRecord:
        validated_id = _identifier(session_id, "session identifier")
        validated_content = _validated_summary_content(content)
        validated_last_turn = _bounded_integer(
            last_compacted_turn,
            "last compacted turn",
            minimum=0,
        )
        validated_updated_at = _timestamp(updated_at_ms, "summary update time")
        summary_json = _summary_json(validated_content)
        try:
            with self._store.transaction() as connection:
                self._required_session(connection, validated_id)
                turn_row = connection.execute(
                    """
                    SELECT assistant_text
                    FROM chat_turns
                    WHERE session_id = ? AND ordinal = ?
                    """,
                    (validated_id, validated_last_turn),
                ).fetchone()
                if turn_row is None or not str(turn_row["assistant_text"]):
                    raise ChatMemoryValidationError(
                        "A summary must end on an existing completed turn."
                    )
                existing = connection.execute(
                    """
                    SELECT created_at_ms, updated_at_ms, last_compacted_turn
                    FROM chat_summaries
                    WHERE session_id = ?
                    """,
                    (validated_id,),
                ).fetchone()
                if existing is not None and (
                    validated_updated_at < int(existing["updated_at_ms"])
                    or validated_last_turn < int(existing["last_compacted_turn"])
                ):
                    raise ChatMemoryValidationError(
                        "Chat summaries cannot move backwards."
                    )
                created_at_ms = (
                    int(existing["created_at_ms"])
                    if existing is not None
                    else validated_updated_at
                )
                connection.execute(
                    """
                    INSERT INTO chat_summaries(
                        session_id,
                        summary_version,
                        summary_json,
                        last_compacted_turn,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        summary_version = excluded.summary_version,
                        summary_json = excluded.summary_json,
                        last_compacted_turn = excluded.last_compacted_turn,
                        updated_at_ms = excluded.updated_at_ms
                    """,
                    (
                        validated_id,
                        CHAT_SUMMARY_VERSION,
                        summary_json,
                        validated_last_turn,
                        created_at_ms,
                        validated_updated_at,
                    ),
                )
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat summary could not be saved.") from error
        return ChatSummaryRecord(
            session_id=validated_id,
            content=validated_content,
            last_compacted_turn=validated_last_turn,
            created_at_ms=created_at_ms,
            updated_at_ms=validated_updated_at,
        )

    def load_summary(self, session_id: str) -> ChatSummaryRecord | None:
        validated_id = _identifier(session_id, "session identifier")
        row = self._store.connection.execute(
            """
            SELECT
                summary_version,
                summary_json,
                last_compacted_turn,
                created_at_ms,
                updated_at_ms
            FROM chat_summaries
            WHERE session_id = ?
            """,
            (validated_id,),
        ).fetchone()
        if row is None:
            return None
        if int(row["summary_version"]) != CHAT_SUMMARY_VERSION:
            raise ChatMemoryRepositoryError("The chat summary version is incompatible.")
        try:
            content = _summary_content_from_json(str(row["summary_json"]))
        except ChatMemoryValidationError as error:
            raise ChatMemoryRepositoryError("The stored chat summary is invalid.") from error
        return ChatSummaryRecord(
            session_id=validated_id,
            content=content,
            last_compacted_turn=int(row["last_compacted_turn"]),
            created_at_ms=int(row["created_at_ms"]),
            updated_at_ms=int(row["updated_at_ms"]),
        )

    def clear_summary(self, session_id: str) -> bool:
        validated_id = _identifier(session_id, "session identifier")
        try:
            with self._store.transaction() as connection:
                deleted = connection.execute(
                    "DELETE FROM chat_summaries WHERE session_id = ?",
                    (validated_id,),
                ).rowcount
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat summary could not be cleared.") from error
        return deleted > 0

    def pin_memory(
        self,
        session_id: str,
        memory_id: str,
        content: str,
        *,
        updated_at_ms: int,
    ) -> PinnedMemoryRecord:
        validated_session_id = _identifier(session_id, "session identifier")
        validated_memory_id = _identifier(memory_id, "memory identifier")
        validated_content = _bounded_content(
            content,
            "pinned memory",
            MAX_PINNED_MEMORY_CHARACTERS,
        )
        validated_updated_at = _timestamp(updated_at_ms, "memory update time")
        try:
            with self._store.transaction() as connection:
                self._required_session(connection, validated_session_id)
                existing = connection.execute(
                    """
                    SELECT created_at_ms, updated_at_ms
                    FROM pinned_memories
                    WHERE session_id = ? AND memory_id = ?
                    """,
                    (validated_session_id, validated_memory_id),
                ).fetchone()
                if existing is None:
                    count = int(connection.execute(
                        "SELECT COUNT(*) FROM pinned_memories WHERE session_id = ?",
                        (validated_session_id,),
                    ).fetchone()[0])
                    if count >= MAX_PINNED_MEMORIES:
                        raise ChatMemoryValidationError(
                            "The chat has reached its pinned-memory limit."
                        )
                    created_at_ms = validated_updated_at
                else:
                    if validated_updated_at < int(existing["updated_at_ms"]):
                        raise ChatMemoryValidationError(
                            "The memory update time cannot move backwards."
                        )
                    created_at_ms = int(existing["created_at_ms"])
                connection.execute(
                    """
                    INSERT INTO pinned_memories(
                        session_id,
                        memory_id,
                        content,
                        created_at_ms,
                        updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(session_id, memory_id) DO UPDATE SET
                        content = excluded.content,
                        updated_at_ms = excluded.updated_at_ms
                    """,
                    (
                        validated_session_id,
                        validated_memory_id,
                        validated_content,
                        created_at_ms,
                        validated_updated_at,
                    ),
                )
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The memory could not be pinned.") from error
        return PinnedMemoryRecord(
            session_id=validated_session_id,
            memory_id=validated_memory_id,
            content=validated_content,
            created_at_ms=created_at_ms,
            updated_at_ms=validated_updated_at,
        )

    def list_pinned_memories(self, session_id: str) -> tuple[PinnedMemoryRecord, ...]:
        validated_id = _identifier(session_id, "session identifier")
        rows = self._store.connection.execute(
            """
            SELECT memory_id, content, created_at_ms, updated_at_ms
            FROM pinned_memories
            WHERE session_id = ?
            ORDER BY created_at_ms, memory_id
            """,
            (validated_id,),
        ).fetchall()
        return tuple(
            PinnedMemoryRecord(
                session_id=validated_id,
                memory_id=str(row["memory_id"]),
                content=str(row["content"]),
                created_at_ms=int(row["created_at_ms"]),
                updated_at_ms=int(row["updated_at_ms"]),
            )
            for row in rows
        )

    def unpin_memory(self, session_id: str, memory_id: str) -> bool:
        validated_session_id = _identifier(session_id, "session identifier")
        validated_memory_id = _identifier(memory_id, "memory identifier")
        try:
            with self._store.transaction() as connection:
                deleted = connection.execute(
                    """
                    DELETE FROM pinned_memories
                    WHERE session_id = ? AND memory_id = ?
                    """,
                    (validated_session_id, validated_memory_id),
                ).rowcount
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The pinned memory could not be removed.") from error
        return deleted > 0

    def delete_session(self, session_id: str) -> bool:
        validated_id = _identifier(session_id, "session identifier")
        try:
            with self._store.transaction() as connection:
                deleted = connection.execute(
                    "DELETE FROM chat_sessions WHERE session_id = ?",
                    (validated_id,),
                ).rowcount
        except sqlite3.Error as error:
            raise ChatMemoryRepositoryError("The chat session could not be deleted.") from error
        return deleted > 0

    @staticmethod
    def _save_snapshot(connection, snapshot: ChatSessionSnapshot) -> None:
        session = snapshot.session
        connection.execute(
            """
            INSERT INTO chat_sessions(
                session_id,
                workspace_identity,
                workspace_name,
                title,
                created_at_ms,
                updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                workspace_identity = excluded.workspace_identity,
                workspace_name = excluded.workspace_name,
                title = excluded.title,
                created_at_ms = excluded.created_at_ms,
                updated_at_ms = excluded.updated_at_ms
            """,
            (
                session.session_id,
                session.workspace_identity,
                session.workspace_name,
                session.title,
                session.created_at_ms,
                session.updated_at_ms,
            ),
        )
        connection.execute(
            "DELETE FROM chat_turns WHERE session_id = ?",
            (session.session_id,),
        )
        connection.executemany(
            """
            INSERT INTO chat_turns(
                session_id,
                ordinal,
                user_text,
                assistant_text,
                file_changes_json
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                (
                    session.session_id,
                    turn.ordinal,
                    turn.user,
                    turn.assistant,
                    turn.file_changes_json,
                )
                for turn in snapshot.turns
            ),
        )
        ChatMemoryRepository._remove_invalid_summary(connection, session.session_id)

    @staticmethod
    def _required_session(connection, session_id: str):
        row = connection.execute(
            """
            SELECT created_at_ms, updated_at_ms
            FROM chat_sessions
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            raise ChatMemoryNotFoundError("The chat session does not exist.")
        return row

    @staticmethod
    def _remove_invalid_summary(connection, session_id: str) -> None:
        connection.execute(
            """
            DELETE FROM chat_summaries
            WHERE session_id = ? AND NOT EXISTS (
                SELECT 1
                FROM chat_turns
                WHERE chat_turns.session_id = chat_summaries.session_id
                    AND chat_turns.ordinal = chat_summaries.last_compacted_turn
                    AND length(chat_turns.assistant_text) > 0
            )
            """,
            (session_id,),
        )


def _validated_snapshot(value: object) -> ChatSessionSnapshot:
    if not isinstance(value, ChatSessionSnapshot):
        raise ChatMemoryValidationError("The chat session snapshot is invalid.")
    session = _validated_session(value.session)
    if len(value.turns) > MAX_CHAT_TURNS_PER_SNAPSHOT:
        raise ChatMemoryValidationError("The chat session contains too many turns.")
    turns = tuple(_validated_turn(turn) for turn in value.turns)
    if [turn.ordinal for turn in turns] != list(range(len(turns))):
        raise ChatMemoryValidationError("Chat turn ordinals must be contiguous and ordered.")
    return ChatSessionSnapshot(session=session, turns=turns)


def _validated_session(value: object) -> ChatSessionRecord:
    if not isinstance(value, ChatSessionRecord):
        raise ChatMemoryValidationError("The chat session is invalid.")
    session_id = _identifier(value.session_id, "session identifier")
    workspace_identity = _bounded_identifier_text(
        value.workspace_identity,
        "workspace identity",
        MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
    )
    workspace_name = _bounded_identifier_text(
        value.workspace_name,
        "workspace name",
        MAX_CHAT_WORKSPACE_NAME_CHARACTERS,
    )
    title = _bounded_identifier_text(
        value.title,
        "session title",
        MAX_CHAT_SESSION_TITLE_CHARACTERS,
    )
    created_at_ms = _timestamp(value.created_at_ms, "session creation time")
    updated_at_ms = _timestamp(value.updated_at_ms, "session update time")
    if updated_at_ms < created_at_ms:
        raise ChatMemoryValidationError(
            "The session update time cannot precede its creation time."
        )
    return ChatSessionRecord(
        session_id=session_id,
        workspace_identity=workspace_identity,
        workspace_name=workspace_name,
        title=title,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def _validated_turn(value: object) -> ChatTurnRecord:
    if not isinstance(value, ChatTurnRecord):
        raise ChatMemoryValidationError("The chat turn is invalid.")
    return ChatTurnRecord(
        ordinal=_bounded_integer(value.ordinal, "turn ordinal", minimum=0),
        user=_turn_text(value.user, "user message", allow_empty=False),
        assistant=_turn_text(value.assistant, "assistant message", allow_empty=True),
        file_changes_json=_file_changes_json(value.file_changes_json),
    )


def _validated_summary_content(value: object) -> ChatSummaryContent:
    if not isinstance(value, ChatSummaryContent):
        raise ChatMemoryValidationError("The chat summary is invalid.")
    goal = _bounded_content(
        value.goal,
        "summary goal",
        MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
    )
    if not isinstance(value.decisions, tuple) or len(value.decisions) > MAX_CHAT_SUMMARY_ITEMS:
        raise ChatMemoryValidationError("The summary decisions list is invalid.")
    decisions = tuple(_validated_decision(item) for item in value.decisions)
    fields = {
        name: _summary_items(getattr(value, name), name.replace("_", " "))
        for name in _SUMMARY_FIELDS
    }
    content = ChatSummaryContent(
        goal=goal,
        constraints=fields["constraints"],
        decisions=decisions,
        important_files=fields["important_files"],
        completed_work=fields["completed_work"],
        open_tasks=fields["open_tasks"],
        unresolved_questions=fields["unresolved_questions"],
    )
    if len(_summary_json(content)) > MAX_CHAT_SUMMARY_CHARACTERS:
        raise ChatMemoryValidationError("The chat summary is too large.")
    return content


def _validated_decision(value: object) -> ChatDecision:
    if not isinstance(value, ChatDecision):
        raise ChatMemoryValidationError("The chat summary decision is invalid.")
    return ChatDecision(
        decision=_bounded_content(
            value.decision,
            "summary decision",
            MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
        ),
        reason=_bounded_content(
            value.reason,
            "summary decision reason",
            MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
        ),
    )


def _summary_items(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, tuple) or len(value) > MAX_CHAT_SUMMARY_ITEMS:
        raise ChatMemoryValidationError(f"The summary {label} list is invalid.")
    return tuple(
        _bounded_content(item, f"summary {label} item", MAX_CHAT_SUMMARY_ITEM_CHARACTERS)
        for item in value
    )


def _summary_json(content: ChatSummaryContent) -> str:
    return json.dumps(
        {
            "goal": content.goal,
            "constraints": list(content.constraints),
            "decisions": [
                {"decision": item.decision, "reason": item.reason}
                for item in content.decisions
            ],
            "importantFiles": list(content.important_files),
            "completedWork": list(content.completed_work),
            "openTasks": list(content.open_tasks),
            "unresolvedQuestions": list(content.unresolved_questions),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _summary_content_from_json(value: str) -> ChatSummaryContent:
    try:
        payload = json.loads(value, parse_constant=_reject_json_constant)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ChatMemoryValidationError("The chat summary JSON is invalid.") from error
    if not isinstance(payload, dict) or set(payload) != {
        "goal",
        "constraints",
        "decisions",
        "importantFiles",
        "completedWork",
        "openTasks",
        "unresolvedQuestions",
    }:
        raise ChatMemoryValidationError("The chat summary structure is invalid.")
    decisions_value = payload["decisions"]
    if not isinstance(decisions_value, list):
        raise ChatMemoryValidationError("The chat summary decisions are invalid.")
    decisions: list[ChatDecision] = []
    for item in decisions_value:
        if not isinstance(item, dict) or set(item) != {"decision", "reason"}:
            raise ChatMemoryValidationError("The chat summary decision is invalid.")
        decisions.append(ChatDecision(item["decision"], item["reason"]))
    for key in (
        "constraints",
        "importantFiles",
        "completedWork",
        "openTasks",
        "unresolvedQuestions",
    ):
        if not isinstance(payload[key], list):
            raise ChatMemoryValidationError("The chat summary structure is invalid.")
    return _validated_summary_content(ChatSummaryContent(
        goal=payload["goal"],
        constraints=tuple(payload["constraints"]),
        decisions=tuple(decisions),
        important_files=tuple(payload["importantFiles"]),
        completed_work=tuple(payload["completedWork"]),
        open_tasks=tuple(payload["openTasks"]),
        unresolved_questions=tuple(payload["unresolvedQuestions"]),
    ))


def _session_from_row(row) -> ChatSessionRecord:
    return ChatSessionRecord(
        session_id=str(row["session_id"]),
        workspace_identity=str(row["workspace_identity"]),
        workspace_name=str(row["workspace_name"]),
        title=str(row["title"]),
        created_at_ms=int(row["created_at_ms"]),
        updated_at_ms=int(row["updated_at_ms"]),
    )


def _turn_from_row(row) -> ChatTurnRecord:
    return ChatTurnRecord(
        ordinal=int(row["ordinal"]),
        user=str(row["user_text"]),
        assistant=str(row["assistant_text"]),
        file_changes_json=str(row["file_changes_json"]),
    )


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER_PATTERN.fullmatch(value) is None:
        raise ChatMemoryValidationError(f"The {label} is invalid.")
    return value


def _bounded_identifier_text(value: object, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 for character in value)
    ):
        raise ChatMemoryValidationError(f"The {label} is invalid.")
    return value


def _bounded_content(value: object, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or "\0" in value
    ):
        raise ChatMemoryValidationError(f"The {label} is invalid.")
    return value


def _turn_text(value: object, label: str, *, allow_empty: bool) -> str:
    if (
        not isinstance(value, str)
        or (not allow_empty and not value.strip())
        or len(value) > MAX_CHAT_TURN_CHARACTERS
        or "\0" in value
    ):
        raise ChatMemoryValidationError(f"The {label} is invalid.")
    return value


def _file_changes_json(value: object) -> str:
    if (
        not isinstance(value, str)
        or not 2 <= len(value) <= MAX_CHAT_FILE_CHANGES_JSON_CHARACTERS
    ):
        raise ChatMemoryValidationError("The file-change summary JSON is invalid.")
    try:
        payload = json.loads(value, parse_constant=_reject_json_constant)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ChatMemoryValidationError("The file-change summary JSON is invalid.") from error
    if not isinstance(payload, list):
        raise ChatMemoryValidationError("The file-change summary JSON must be an array.")
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(canonical) > MAX_CHAT_FILE_CHANGES_JSON_CHARACTERS:
        raise ChatMemoryValidationError("The file-change summary JSON is too large.")
    return canonical


def _timestamp(value: object, label: str) -> int:
    return _bounded_integer(value, label, minimum=0)


def _bounded_integer(
    value: object,
    label: str,
    *,
    minimum: int,
    maximum: int = 9_223_372_036_854_775_807,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not minimum <= value <= maximum
    ):
        raise ChatMemoryValidationError(f"The {label} is invalid.")
    return value


def _reject_json_constant(value: str):
    raise ValueError(f"Invalid JSON constant: {value}")
