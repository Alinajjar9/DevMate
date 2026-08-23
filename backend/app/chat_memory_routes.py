import json
from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends
from pydantic import ValidationError

from .api_models import (
    ChatMemoryDeleteData,
    ChatMemoryDeleteResult,
    ChatMemoryListData,
    ChatMemoryListRequest,
    ChatMemoryListResult,
    ChatMemoryLoadData,
    ChatMemoryLoadResult,
    ChatMemorySaveData,
    ChatMemorySaveRequest,
    ChatMemorySaveResult,
    ChatMemorySessionData,
    ChatMemorySessionRequest,
    ChatMemorySnapshotData,
    ChatMemoryTurnData,
)
from .chat_memory_contracts import DEVMATE_CHAT_MEMORY_API_VERSION
from .chat_memory_repository import (
    ChatMemoryNotFoundError,
    ChatMemoryRepository,
    ChatMemoryRepositoryError,
    ChatMemoryValidationError,
    ChatSessionRecord,
    ChatSessionSnapshot,
    ChatTurnRecord,
)
from .dependencies import get_chat_memory_repository
from .errors import BackendApiError


chat_memory_router = APIRouter(
    prefix=f"/memory/v{DEVMATE_CHAT_MEMORY_API_VERSION}",
)


def _raise_repository_error(error: ChatMemoryRepositoryError) -> NoReturn:
    if isinstance(error, ChatMemoryValidationError):
        raise BackendApiError(422, "request_validation_failed", str(error)) from error
    if isinstance(error, ChatMemoryNotFoundError):
        raise BackendApiError(
            404,
            "chat_session_not_found",
            "The requested chat session does not exist.",
        ) from error
    raise BackendApiError(
        500,
        "chat_memory_failure",
        "The local DevMate chat-memory operation failed.",
    ) from error


def _session_record(value: ChatMemorySessionData) -> ChatSessionRecord:
    return ChatSessionRecord(
        session_id=value.sessionId,
        workspace_identity=value.workspaceIdentity,
        workspace_name=value.workspaceName,
        title=value.title,
        created_at_ms=value.createdAtMs,
        updated_at_ms=value.updatedAtMs,
    )


def _turn_record(value: ChatMemoryTurnData) -> ChatTurnRecord:
    return ChatTurnRecord(
        ordinal=value.ordinal,
        user=value.user,
        assistant=value.assistant,
        file_changes_json=json.dumps(
            [change.model_dump(exclude_none=True) for change in value.fileChanges],
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )


def _snapshot_record(value: ChatMemorySnapshotData) -> ChatSessionSnapshot:
    return ChatSessionSnapshot(
        session=_session_record(value.session),
        turns=tuple(_turn_record(turn) for turn in value.turns),
    )


def _session_data(value: ChatSessionRecord) -> ChatMemorySessionData:
    return ChatMemorySessionData(
        sessionId=value.session_id,
        workspaceIdentity=value.workspace_identity,
        workspaceName=value.workspace_name,
        title=value.title,
        createdAtMs=value.created_at_ms,
        updatedAtMs=value.updated_at_ms,
    )


def _snapshot_data(value: ChatSessionSnapshot) -> ChatMemorySnapshotData:
    try:
        turns = [
            ChatMemoryTurnData(
                ordinal=turn.ordinal,
                user=turn.user,
                assistant=turn.assistant,
                fileChanges=json.loads(turn.file_changes_json),
            )
            for turn in value.turns
        ]
        return ChatMemorySnapshotData(
            session=_session_data(value.session),
            turns=turns,
        )
    except (json.JSONDecodeError, TypeError, ValidationError) as error:
        raise ChatMemoryRepositoryError(
            "The stored chat session does not match the API contract."
        ) from error


@chat_memory_router.post(
    "/sessions/save",
    response_model=ChatMemorySaveResult,
    response_model_exclude_none=True,
)
async def save_chat_memory_sessions(
    request: ChatMemorySaveRequest,
    repository: Annotated[ChatMemoryRepository, Depends(get_chat_memory_repository)],
) -> ChatMemorySaveResult:
    try:
        snapshots = repository.save_sessions(
            tuple(_snapshot_record(snapshot) for snapshot in request.sessions)
        )
    except ChatMemoryRepositoryError as error:
        _raise_repository_error(error)
    return ChatMemorySaveResult(
        status="ok",
        data=ChatMemorySaveData(
            savedSessionIds=[snapshot.session.session_id for snapshot in snapshots],
        ),
    )


@chat_memory_router.post(
    "/sessions/load",
    response_model=ChatMemoryLoadResult,
    response_model_exclude_none=True,
)
async def load_chat_memory_session(
    request: ChatMemorySessionRequest,
    repository: Annotated[ChatMemoryRepository, Depends(get_chat_memory_repository)],
) -> ChatMemoryLoadResult:
    try:
        snapshot = repository.load_session(request.sessionId)
        if snapshot is None:
            raise ChatMemoryNotFoundError("The chat session does not exist.")
        data = _snapshot_data(snapshot)
    except ChatMemoryRepositoryError as error:
        _raise_repository_error(error)
    return ChatMemoryLoadResult(status="ok", data=ChatMemoryLoadData(session=data))


@chat_memory_router.post(
    "/sessions/list",
    response_model=ChatMemoryListResult,
    response_model_exclude_none=True,
)
async def list_chat_memory_sessions(
    request: ChatMemoryListRequest,
    repository: Annotated[ChatMemoryRepository, Depends(get_chat_memory_repository)],
) -> ChatMemoryListResult:
    try:
        sessions = repository.list_sessions(
            request.workspaceIdentity,
            limit=request.limit,
        )
    except ChatMemoryRepositoryError as error:
        _raise_repository_error(error)
    return ChatMemoryListResult(
        status="ok",
        data=ChatMemoryListData(
            sessions=[_session_data(session) for session in sessions],
        ),
    )


@chat_memory_router.post(
    "/sessions/delete",
    response_model=ChatMemoryDeleteResult,
    response_model_exclude_none=True,
)
async def delete_chat_memory_session(
    request: ChatMemorySessionRequest,
    repository: Annotated[ChatMemoryRepository, Depends(get_chat_memory_repository)],
) -> ChatMemoryDeleteResult:
    try:
        deleted = repository.delete_session(request.sessionId)
    except ChatMemoryRepositoryError as error:
        _raise_repository_error(error)
    return ChatMemoryDeleteResult(
        status="ok",
        data=ChatMemoryDeleteData(deleted=deleted),
    )
