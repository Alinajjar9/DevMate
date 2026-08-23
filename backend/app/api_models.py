import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .chat_memory_contracts import (
    CHAT_SUMMARY_VERSION,
    FILE_CHANGE_KINDS,
    MAX_CHAT_DIFF_ID_CHARACTERS,
    MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS,
    MAX_CHAT_FILE_CHANGES,
    MAX_CHAT_INTEGER,
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
    FileChangeKind,
)
from .embedding_providers import (
    MAX_EMBEDDING_BASE_URL_CHARACTERS,
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
    MAX_EMBEDDING_MODEL_CHARACTERS,
    MAX_EMBEDDING_PROFILE_ID_CHARACTERS,
    EmbeddingProviderName,
)
from .knowledge_contracts import (
    MAX_CHUNKS_PER_FILE,
    MAX_CHUNK_CHARACTERS,
    MAX_CHUNK_STABLE_ID_CHARACTERS,
    MAX_CONTENT_HASH_CHARACTERS,
    MAX_FILE_CHANGES_PER_BATCH,
    MAX_INDEX_BATCH_CONTENT_CHARACTERS,
    MAX_INDEX_INTEGER,
    MAX_LANGUAGE_ID_CHARACTERS,
    MAX_LEXICAL_QUERY_CHARACTERS,
    MAX_LEXICAL_RESULTS,
    MAX_SEMANTIC_QUERY_CHARACTERS,
    MAX_SEMANTIC_RESULTS,
    MAX_RELATIVE_PATH_CHARACTERS,
    MAX_WORKSPACE_KEY_CHARACTERS,
    MAX_WORKSPACE_ROOT_CHARACTERS,
    IndexState,
)


DEVMATE_BACKEND_VERSION = "1.0.0"
DEVMATE_BACKEND_SERVICE = "devmate-backend"
DEVMATE_BACKEND_PROTOCOL_VERSION = 2
DEVMATE_BACKEND_TOKEN_HEADER = "X-DevMate-Backend-Token"
DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = "DEVMATE_BACKEND_TOKEN"
MIN_BACKEND_TOKEN_CHARACTERS = 32
MAX_BACKEND_TOKEN_CHARACTERS = 512

AssistantMode = Literal["ideas", "code", "debug"]
ScopeType = Literal["project", "file", "selection"]
ProviderName = Literal["openai", "ollama"]
ReasoningEffort = Literal["auto", "low", "medium", "high", "xhigh"]
BackendCapability = Literal[
    "chat",
    "streaming",
    "request-authentication",
    "strict-response-contracts",
    "knowledge-index-v1",
    "embedding-index-v1",
    "semantic-search-v1",
    "chat-memory-v1",
]
DEVMATE_BACKEND_CAPABILITIES: tuple[BackendCapability, ...] = (
    "chat",
    "streaming",
    "request-authentication",
    "strict-response-contracts",
    "knowledge-index-v1",
    "embedding-index-v1",
    "semantic-search-v1",
    "chat-memory-v1",
)
BackendErrorCode = Literal[
    "backend_authentication_failed",
    "request_validation_failed",
    "route_unavailable",
    "provider_configuration",
    "provider_authentication_failed",
    "provider_not_found",
    "provider_rate_limited",
    "provider_timeout",
    "provider_unavailable",
    "provider_invalid_response",
    "model_invalid_response",
    "knowledge_store_unavailable",
    "knowledge_workspace_not_found",
    "knowledge_index_failure",
    "chat_session_not_found",
    "chat_memory_failure",
    "internal_error",
]
ProviderErrorCode = Literal[
    "provider_configuration",
    "provider_authentication_failed",
    "provider_not_found",
    "provider_rate_limited",
    "provider_timeout",
    "provider_unavailable",
    "provider_invalid_response",
]
ContextSource = Literal["file", "selection", "attachment"]
AgentToolName = Literal[
    "list_files",
    "read_file",
    "search_code",
    "get_symbols",
    "find_definition",
    "find_references",
    "get_diagnostics",
    "read_terminal_errors",
    "create_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "move_file",
    "install_dependencies",
    "run_command",
]

MAX_CONTEXT_CHARACTERS = 20_000
MAX_PROJECT_CONTEXT_FILES = 5
MAX_PROJECT_FILE_CHARACTERS = 8_000
MAX_PROJECT_CONTEXT_CHARACTERS = 40_000
MAX_ATTACHED_FILES = 5
MAX_REQUEST_CONTEXT_ITEMS = 6
MAX_REQUEST_CONTEXT_CHARACTERS = 40_000
MAX_AGENT_TOOL_STEPS = 100
MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000
MAX_AGENT_TOOL_HISTORY_CHARACTERS = 80_000
MAX_CONVERSATION_TURNS = 6
MAX_CONVERSATION_TURN_CHARACTERS = 6_000
MAX_CONVERSATION_HISTORY_CHARACTERS = 20_000

READ_ONLY_AGENT_TOOLS: tuple[AgentToolName, ...] = (
    "list_files",
    "read_file",
    "search_code",
    "get_symbols",
    "find_definition",
    "find_references",
    "get_diagnostics",
    "read_terminal_errors",
)
MUTATING_AGENT_TOOLS: tuple[AgentToolName, ...] = (
    "create_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "move_file",
    "install_dependencies",
    "run_command",
)


def _utf16_character_count(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


class LlmSettings(BaseModel):
    provider: ProviderName
    model: str = Field(min_length=1, max_length=120)
    baseUrl: str | None = Field(default=None, max_length=2_048)
    maxTokens: int = Field(ge=128, le=32_000)
    temperature: float = Field(ge=0, le=2)
    reasoningEffort: ReasoningEffort = "auto"
    timeoutSeconds: float = Field(default=900, ge=10, le=1_800)


class AskContextItem(BaseModel):
    source: ContextSource
    filePath: str = Field(min_length=1)
    languageId: str = Field(min_length=1)
    content: str = Field(max_length=MAX_CONTEXT_CHARACTERS)
    includedCharacters: int = Field(ge=0, le=MAX_CONTEXT_CHARACTERS)
    totalCharacters: int = Field(ge=0)
    truncated: bool

    @model_validator(mode="after")
    def validate_character_metadata(self) -> "AskContextItem":
        if self.includedCharacters != _utf16_character_count(self.content):
            raise ValueError("includedCharacters must match the content length")
        if self.includedCharacters > self.totalCharacters:
            raise ValueError("includedCharacters cannot exceed totalCharacters")
        if self.truncated != (self.includedCharacters < self.totalCharacters):
            raise ValueError("truncated must match the included and total character counts")
        return self


class AskScope(BaseModel):
    type: ScopeType
    workspacePath: str | None = None
    items: list[AskContextItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_items_for_scope(self) -> "AskScope":
        attachments = [item for item in self.items if item.source == "attachment"]
        primary_items = [item for item in self.items if item.source != "attachment"]

        if len(attachments) > MAX_ATTACHED_FILES:
            raise ValueError("scope contains too many attached files")
        if len(self.items) > MAX_REQUEST_CONTEXT_ITEMS:
            raise ValueError("scope contains too many context items")
        if sum(item.includedCharacters for item in self.items) > MAX_REQUEST_CONTEXT_CHARACTERS:
            raise ValueError("scope exceeds the total context limit")
        if any(
            item.includedCharacters > MAX_PROJECT_FILE_CHARACTERS
            for item in attachments
        ):
            raise ValueError("scope contains an oversized attached file")
        if self.type == "file" and (
            len(primary_items) != 1 or primary_items[0].source != "file"
        ):
            raise ValueError("file scope requires exactly one file context item")
        if self.type == "selection" and (
            len(primary_items) != 1 or primary_items[0].source != "selection"
        ):
            raise ValueError("selection scope requires exactly one selection context item")
        if self.type == "project" and any(
            item.source not in {"file", "attachment"} for item in self.items
        ):
            raise ValueError("project scope can only contain file context items")
        if self.type == "project" and len(self.items) > MAX_PROJECT_CONTEXT_FILES:
            raise ValueError("project scope contains too many context files")
        if self.type == "project" and sum(
            item.includedCharacters for item in self.items
        ) > MAX_PROJECT_CONTEXT_CHARACTERS:
            raise ValueError("project scope exceeds the total context limit")
        if self.type == "project" and any(
            item.includedCharacters > MAX_PROJECT_FILE_CHARACTERS
            for item in primary_items
        ):
            raise ValueError("project scope contains an oversized context file")
        return self


class AgentToolStep(BaseModel):
    callId: str = Field(min_length=1, max_length=120)
    name: AgentToolName
    arguments: dict[str, object] = Field(default_factory=dict)
    result: str = Field(max_length=MAX_AGENT_TOOL_RESULT_CHARACTERS)
    isError: bool = False

    @model_validator(mode="after")
    def validate_arguments_size(self) -> "AgentToolStep":
        if len(json.dumps(self.arguments, separators=(",", ":"))) > 4_000:
            raise ValueError("tool arguments are too large")
        return self


class ConversationTurn(BaseModel):
    user: str = Field(min_length=1, max_length=MAX_CONVERSATION_TURN_CHARACTERS)
    assistant: str = Field(min_length=1, max_length=MAX_CONVERSATION_TURN_CHARACTERS)


class AskRequest(BaseModel):
    question: str = Field(min_length=1)
    mode: AssistantMode
    scope: AskScope
    settings: LlmSettings
    toolsEnabled: bool = True
    enabledTools: list[AgentToolName] | None = None
    agentEditsEnabled: bool = False
    forceFinalAnswer: bool = False
    disableThinking: bool = False
    toolHistory: list[AgentToolStep] = Field(
        default_factory=list,
        max_length=MAX_AGENT_TOOL_STEPS,
    )
    conversationHistory: list[ConversationTurn] = Field(
        default_factory=list,
        max_length=MAX_CONVERSATION_TURNS,
    )
    conversationSummary: "ChatMemorySummaryContentData | None" = None

    @model_validator(mode="after")
    def validate_tool_history(self) -> "AskRequest":
        call_ids = [step.callId for step in self.toolHistory]
        if len(call_ids) != len(set(call_ids)):
            raise ValueError("tool history contains duplicate call ids")
        if sum(len(step.result) for step in self.toolHistory) > MAX_AGENT_TOOL_HISTORY_CHARACTERS:
            raise ValueError("tool history is too large")
        if self.enabledTools is not None and len(self.enabledTools) != len(set(self.enabledTools)):
            raise ValueError("enabled tools contains duplicates")
        if sum(
            len(turn.user) + len(turn.assistant)
            for turn in self.conversationHistory
        ) > MAX_CONVERSATION_HISTORY_CHARACTERS:
            raise ValueError("conversation history is too large")
        return self


class HealthData(BaseModel):
    service: Literal["devmate-backend"]
    protocolVersion: Literal[2]
    capabilities: list[BackendCapability]
    backend: Literal["online"]
    version: str


class HealthResult(BaseModel):
    status: Literal["ok"]
    data: HealthData


class KnowledgeIndexModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KnowledgeIndexWorkspaceRequest(KnowledgeIndexModel):
    workspaceKey: str = Field(min_length=1, max_length=MAX_WORKSPACE_KEY_CHARACTERS)


class KnowledgeIndexOpenRequest(KnowledgeIndexWorkspaceRequest):
    rootPath: str = Field(min_length=1, max_length=MAX_WORKSPACE_ROOT_CHARACTERS)
    chunkingVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)


class KnowledgeIndexWorkspaceData(KnowledgeIndexModel):
    id: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    workspaceKey: str = Field(min_length=1, max_length=MAX_WORKSPACE_KEY_CHARACTERS)
    rootPath: str = Field(min_length=1, max_length=MAX_WORKSPACE_ROOT_CHARACTERS)


class KnowledgeIndexMetadataData(KnowledgeIndexModel):
    workspaceKey: str = Field(min_length=1, max_length=MAX_WORKSPACE_KEY_CHARACTERS)
    chunkingVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    indexState: IndexState
    lastFullScanAt: str | None = Field(default=None, min_length=1, max_length=128)


class KnowledgeIndexFileFingerprintData(KnowledgeIndexModel):
    relativePath: str = Field(min_length=1, max_length=MAX_RELATIVE_PATH_CHARACTERS)
    contentHash: str = Field(min_length=1, max_length=MAX_CONTENT_HASH_CHARACTERS)
    sizeBytes: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    modifiedAt: int = Field(ge=0, le=MAX_INDEX_INTEGER)


class KnowledgeIndexOpenData(KnowledgeIndexModel):
    workspace: KnowledgeIndexWorkspaceData
    metadata: KnowledgeIndexMetadataData
    files: list[KnowledgeIndexFileFingerprintData] = Field(
        max_length=MAX_FILE_CHANGES_PER_BATCH,
    )


class KnowledgeIndexOpenResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexOpenData


class KnowledgeIndexChunkInput(KnowledgeIndexModel):
    stableId: str = Field(min_length=1, max_length=MAX_CHUNK_STABLE_ID_CHARACTERS)
    ordinal: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    startLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    endLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    content: str = Field(min_length=1, max_length=MAX_CHUNK_CHARACTERS)
    contentHash: str = Field(min_length=1, max_length=MAX_CONTENT_HASH_CHARACTERS)
    chunkingVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)


class KnowledgeIndexFileInput(KnowledgeIndexModel):
    relativePath: str = Field(min_length=1, max_length=MAX_RELATIVE_PATH_CHARACTERS)
    languageId: str = Field(min_length=1, max_length=MAX_LANGUAGE_ID_CHARACTERS)
    contentHash: str = Field(min_length=1, max_length=MAX_CONTENT_HASH_CHARACTERS)
    sizeBytes: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    modifiedAt: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    chunks: list[KnowledgeIndexChunkInput] = Field(max_length=MAX_CHUNKS_PER_FILE)


class KnowledgeIndexApplyRequest(KnowledgeIndexWorkspaceRequest):
    upserts: list[KnowledgeIndexFileInput] = Field(
        default_factory=list,
        max_length=MAX_FILE_CHANGES_PER_BATCH,
    )
    deletedPaths: list[str] = Field(
        default_factory=list,
        max_length=MAX_FILE_CHANGES_PER_BATCH,
    )

    @model_validator(mode="after")
    def validate_batch_size(self) -> "KnowledgeIndexApplyRequest":
        if len(self.upserts) + len(self.deletedPaths) > MAX_FILE_CHANGES_PER_BATCH:
            raise ValueError("index file-change batch is too large")
        if any(
            not path or len(path) > MAX_RELATIVE_PATH_CHARACTERS
            for path in self.deletedPaths
        ):
            raise ValueError("index deletion path is invalid")
        if sum(
            len(chunk.content)
            for file in self.upserts
            for chunk in file.chunks
        ) > MAX_INDEX_BATCH_CONTENT_CHARACTERS:
            raise ValueError("index file-change content is too large")
        return self


class KnowledgeIndexWriteData(KnowledgeIndexModel):
    upsertedFiles: int = Field(ge=0, le=MAX_FILE_CHANGES_PER_BATCH)
    deletedFiles: int = Field(ge=0, le=MAX_FILE_CHANGES_PER_BATCH)


class KnowledgeIndexWriteResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexWriteData


class KnowledgeIndexMetadataUpdateRequest(KnowledgeIndexWorkspaceRequest):
    chunkingVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    indexState: IndexState
    lastFullScanAt: str | None = Field(default=None, min_length=1, max_length=128)


class KnowledgeIndexMetadataResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexMetadataData


class KnowledgeIndexSearchRequest(KnowledgeIndexWorkspaceRequest):
    query: str = Field(max_length=MAX_LEXICAL_QUERY_CHARACTERS)
    limit: int = Field(ge=1, le=MAX_LEXICAL_RESULTS)


class KnowledgeIndexSearchItemData(KnowledgeIndexModel):
    relativePath: str = Field(min_length=1, max_length=MAX_RELATIVE_PATH_CHARACTERS)
    languageId: str = Field(min_length=1, max_length=MAX_LANGUAGE_ID_CHARACTERS)
    stableId: str = Field(min_length=1, max_length=MAX_CHUNK_STABLE_ID_CHARACTERS)
    ordinal: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    startLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    endLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    content: str = Field(min_length=1, max_length=MAX_CHUNK_CHARACTERS)
    contentHash: str = Field(min_length=1, max_length=MAX_CONTENT_HASH_CHARACTERS)
    score: float = Field(ge=0)


class KnowledgeIndexSearchData(KnowledgeIndexModel):
    results: list[KnowledgeIndexSearchItemData] = Field(max_length=MAX_LEXICAL_RESULTS)


class KnowledgeIndexSearchResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexSearchData


class KnowledgeIndexEmbeddingRequest(KnowledgeIndexWorkspaceRequest):
    profileId: str = Field(
        min_length=1,
        max_length=MAX_EMBEDDING_PROFILE_ID_CHARACTERS,
        pattern=(
            rf"^[A-Za-z0-9][A-Za-z0-9_-]"
            rf"{{0,{MAX_EMBEDDING_PROFILE_ID_CHARACTERS - 1}}}$"
        ),
    )
    provider: EmbeddingProviderName
    model: str = Field(min_length=1, max_length=MAX_EMBEDDING_MODEL_CHARACTERS)
    baseUrl: str = Field(min_length=1, max_length=MAX_EMBEDDING_BASE_URL_CHARACTERS)
    remoteAllowed: bool = False
    vectorVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    batchSize: int = Field(default=MAX_EMBEDDING_BATCH_SIZE, ge=1, le=MAX_EMBEDDING_BATCH_SIZE)
    maxBatches: int = Field(
        default=1,
        ge=1,
        le=MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
    )


class KnowledgeIndexEmbeddingConfigurationData(KnowledgeIndexModel):
    profileId: str = Field(min_length=1, max_length=MAX_EMBEDDING_PROFILE_ID_CHARACTERS)
    provider: EmbeddingProviderName
    model: str = Field(min_length=1, max_length=MAX_EMBEDDING_MODEL_CHARACTERS)
    dimensions: int = Field(ge=1, le=MAX_EMBEDDING_DIMENSIONS)
    vectorVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)


class KnowledgeIndexEmbeddingData(KnowledgeIndexModel):
    configuration: KnowledgeIndexEmbeddingConfigurationData | None
    embeddedChunks: int = Field(
        ge=0,
        le=MAX_EMBEDDING_BATCH_SIZE * MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
    )
    processedBatches: int = Field(ge=0, le=MAX_EMBEDDING_INDEX_BATCHES_PER_RUN)
    complete: bool


class KnowledgeIndexEmbeddingResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexEmbeddingData


class KnowledgeIndexSemanticSearchRequest(KnowledgeIndexWorkspaceRequest):
    query: str = Field(min_length=1, max_length=MAX_SEMANTIC_QUERY_CHARACTERS)
    profileId: str = Field(
        min_length=1,
        max_length=MAX_EMBEDDING_PROFILE_ID_CHARACTERS,
        pattern=(
            rf"^[A-Za-z0-9][A-Za-z0-9_-]"
            rf"{{0,{MAX_EMBEDDING_PROFILE_ID_CHARACTERS - 1}}}$"
        ),
    )
    provider: EmbeddingProviderName
    model: str = Field(min_length=1, max_length=MAX_EMBEDDING_MODEL_CHARACTERS)
    baseUrl: str = Field(min_length=1, max_length=MAX_EMBEDDING_BASE_URL_CHARACTERS)
    remoteAllowed: bool = False
    vectorVersion: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    limit: int = Field(ge=1, le=MAX_SEMANTIC_RESULTS)


class KnowledgeIndexSemanticSearchItemData(KnowledgeIndexModel):
    relativePath: str = Field(min_length=1, max_length=MAX_RELATIVE_PATH_CHARACTERS)
    languageId: str = Field(min_length=1, max_length=MAX_LANGUAGE_ID_CHARACTERS)
    stableId: str = Field(min_length=1, max_length=MAX_CHUNK_STABLE_ID_CHARACTERS)
    ordinal: int = Field(ge=0, le=MAX_INDEX_INTEGER)
    startLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    endLine: int = Field(ge=1, le=MAX_INDEX_INTEGER)
    content: str = Field(min_length=1, max_length=MAX_CHUNK_CHARACTERS)
    contentHash: str = Field(min_length=1, max_length=MAX_CONTENT_HASH_CHARACTERS)
    score: float = Field(ge=-1, le=1)


class KnowledgeIndexSemanticSearchData(KnowledgeIndexModel):
    configuration: KnowledgeIndexEmbeddingConfigurationData | None
    results: list[KnowledgeIndexSemanticSearchItemData] = Field(
        max_length=MAX_SEMANTIC_RESULTS,
    )

    @model_validator(mode="after")
    def validate_results_have_configuration(self) -> "KnowledgeIndexSemanticSearchData":
        if self.configuration is None and self.results:
            raise ValueError("semantic results require an active embedding configuration")
        return self


class KnowledgeIndexSemanticSearchResult(KnowledgeIndexModel):
    status: Literal["ok"]
    data: KnowledgeIndexSemanticSearchData


class ChatMemoryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatMemoryFileChangeData(ChatMemoryModel):
    kind: FileChangeKind
    path: str = Field(min_length=1)
    previousPath: str | None = None
    diffId: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_CHAT_DIFF_ID_CHARACTERS,
        pattern=r"^[A-Za-z0-9_-]+$",
    )

    @model_validator(mode="after")
    def validate_file_change(self) -> "ChatMemoryFileChangeData":
        if self.kind not in FILE_CHANGE_KINDS:
            raise ValueError("file-change kind is invalid")
        _validate_chat_identifier_text(
            self.path,
            "file-change path",
            MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS,
        )
        if self.kind in ("renamed", "moved"):
            if self.previousPath is None:
                raise ValueError("relocated file changes require a previous path")
            _validate_chat_identifier_text(
                self.previousPath,
                "previous file-change path",
                MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS,
            )
        elif self.previousPath is not None:
            raise ValueError("only relocated file changes may include a previous path")
        return self


class ChatMemoryTurnData(ChatMemoryModel):
    ordinal: int = Field(ge=0, le=MAX_CHAT_INTEGER)
    user: str = Field(min_length=1)
    assistant: str
    fileChanges: list[ChatMemoryFileChangeData] = Field(
        default_factory=list,
        max_length=MAX_CHAT_FILE_CHANGES,
    )

    @model_validator(mode="after")
    def validate_turn_text(self) -> "ChatMemoryTurnData":
        _validate_chat_content(
            self.user,
            "user message",
            MAX_CHAT_TURN_CHARACTERS,
            allow_empty=False,
        )
        _validate_chat_content(
            self.assistant,
            "assistant message",
            MAX_CHAT_TURN_CHARACTERS,
            allow_empty=True,
        )
        return self


class ChatMemorySessionData(ChatMemoryModel):
    sessionId: str = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSION_ID_CHARACTERS,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    )
    workspaceIdentity: str = Field(min_length=1)
    workspaceName: str = Field(min_length=1)
    title: str = Field(min_length=1)
    createdAtMs: int = Field(ge=0, le=MAX_CHAT_INTEGER)
    updatedAtMs: int = Field(ge=0, le=MAX_CHAT_INTEGER)

    @model_validator(mode="after")
    def validate_session_metadata(self) -> "ChatMemorySessionData":
        _validate_chat_identifier_text(
            self.workspaceIdentity,
            "workspace identity",
            MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
        )
        _validate_chat_identifier_text(
            self.workspaceName,
            "workspace name",
            MAX_CHAT_WORKSPACE_NAME_CHARACTERS,
        )
        _validate_chat_identifier_text(
            self.title,
            "session title",
            MAX_CHAT_SESSION_TITLE_CHARACTERS,
        )
        if self.updatedAtMs < self.createdAtMs:
            raise ValueError("session update time cannot precede its creation time")
        return self


class ChatMemorySnapshotData(ChatMemoryModel):
    session: ChatMemorySessionData
    turns: list[ChatMemoryTurnData] = Field(max_length=MAX_CHAT_TURNS_PER_SNAPSHOT)

    @model_validator(mode="after")
    def validate_turn_order(self) -> "ChatMemorySnapshotData":
        if [turn.ordinal for turn in self.turns] != list(range(len(self.turns))):
            raise ValueError("chat turn ordinals must be contiguous and ordered")
        return self


class ChatMemorySaveRequest(ChatMemoryModel):
    sessions: list[ChatMemorySnapshotData] = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSIONS_PER_REQUEST,
    )

    @model_validator(mode="after")
    def validate_unique_sessions(self) -> "ChatMemorySaveRequest":
        session_ids = [snapshot.session.sessionId for snapshot in self.sessions]
        if len(set(session_ids)) != len(session_ids):
            raise ValueError("chat-session identifiers must be unique")
        return self


class ChatMemorySaveData(ChatMemoryModel):
    savedSessionIds: list[str] = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSIONS_PER_REQUEST,
    )


class ChatMemorySaveResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemorySaveData


class ChatMemorySessionRequest(ChatMemoryModel):
    sessionId: str = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSION_ID_CHARACTERS,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    )


class ChatMemoryLoadData(ChatMemoryModel):
    session: ChatMemorySnapshotData


class ChatMemoryLoadResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemoryLoadData


class ChatMemoryListRequest(ChatMemoryModel):
    workspaceIdentity: str = Field(min_length=1)
    limit: int = Field(default=20, ge=1, le=MAX_CHAT_SESSIONS_RETURNED)

    @model_validator(mode="after")
    def validate_workspace_identity(self) -> "ChatMemoryListRequest":
        _validate_chat_identifier_text(
            self.workspaceIdentity,
            "workspace identity",
            MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
        )
        return self


class ChatMemoryListData(ChatMemoryModel):
    sessions: list[ChatMemorySessionData] = Field(max_length=MAX_CHAT_SESSIONS_RETURNED)


class ChatMemoryListResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemoryListData


class ChatMemoryDeleteData(ChatMemoryModel):
    deleted: bool


class ChatMemoryDeleteResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemoryDeleteData


class ChatMemorySummaryDecisionData(ChatMemoryModel):
    decision: str = Field(min_length=1)
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_decision_text(self) -> "ChatMemorySummaryDecisionData":
        _validate_chat_content(
            self.decision,
            "summary decision",
            MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
            allow_empty=False,
        )
        _validate_chat_content(
            self.reason,
            "summary decision reason",
            MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
            allow_empty=False,
        )
        return self


class ChatMemorySummaryContentData(ChatMemoryModel):
    goal: str = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list, max_length=MAX_CHAT_SUMMARY_ITEMS)
    decisions: list[ChatMemorySummaryDecisionData] = Field(
        default_factory=list,
        max_length=MAX_CHAT_SUMMARY_ITEMS,
    )
    importantFiles: list[str] = Field(default_factory=list, max_length=MAX_CHAT_SUMMARY_ITEMS)
    completedWork: list[str] = Field(default_factory=list, max_length=MAX_CHAT_SUMMARY_ITEMS)
    openTasks: list[str] = Field(default_factory=list, max_length=MAX_CHAT_SUMMARY_ITEMS)
    unresolvedQuestions: list[str] = Field(
        default_factory=list,
        max_length=MAX_CHAT_SUMMARY_ITEMS,
    )

    @model_validator(mode="after")
    def validate_summary_content(self) -> "ChatMemorySummaryContentData":
        _validate_chat_content(
            self.goal,
            "summary goal",
            MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
            allow_empty=False,
        )
        for label, values in (
            ("constraints", self.constraints),
            ("important files", self.importantFiles),
            ("completed work", self.completedWork),
            ("open tasks", self.openTasks),
            ("unresolved questions", self.unresolvedQuestions),
        ):
            for value in values:
                _validate_chat_content(
                    value,
                    f"summary {label} item",
                    MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
                    allow_empty=False,
                )
        serialized = json.dumps(
            self.model_dump(),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if _utf16_character_count(serialized) > MAX_CHAT_SUMMARY_CHARACTERS:
            raise ValueError("chat summary is too large")
        return self


class ChatMemorySummaryData(ChatMemoryModel):
    sessionId: str = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSION_ID_CHARACTERS,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    )
    summaryVersion: Literal[CHAT_SUMMARY_VERSION]
    content: ChatMemorySummaryContentData
    lastCompactedTurn: int = Field(ge=0, le=MAX_CHAT_INTEGER)
    createdAtMs: int = Field(ge=0, le=MAX_CHAT_INTEGER)
    updatedAtMs: int = Field(ge=0, le=MAX_CHAT_INTEGER)

    @model_validator(mode="after")
    def validate_summary_timestamps(self) -> "ChatMemorySummaryData":
        if self.updatedAtMs < self.createdAtMs:
            raise ValueError("summary update time cannot precede its creation time")
        return self


class ChatMemorySummaryLoadData(ChatMemoryModel):
    summary: ChatMemorySummaryData | None


class ChatMemorySummaryLoadResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemorySummaryLoadData


class ChatMemoryCompactionRequest(ChatMemoryModel):
    sessionId: str = Field(
        min_length=1,
        max_length=MAX_CHAT_SESSION_ID_CHARACTERS,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    )
    throughTurn: int = Field(ge=0, le=MAX_CHAT_INTEGER)
    settings: LlmSettings


class ChatMemoryCompactionData(ChatMemoryModel):
    summary: ChatMemorySummaryData
    compactedTurns: int = Field(ge=1, le=MAX_CHAT_TURNS_PER_SNAPSHOT)


class ChatMemoryCompactionResult(ChatMemoryModel):
    status: Literal["ok"]
    data: ChatMemoryCompactionData


AskRequest.model_rebuild()


class FileChange(BaseModel):
    path: str
    content: str


class AgentToolCall(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: AgentToolName
    arguments: dict[str, object]


class TokenUsage(BaseModel):
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    totalTokens: int = Field(ge=0)
    exact: bool


class AskData(BaseModel):
    answer: str
    usedFiles: list[str]
    changes: list[FileChange] = Field(default_factory=list)
    toolCalls: list[AgentToolCall] = Field(default_factory=list)
    tokenUsage: TokenUsage


class AskResult(BaseModel):
    status: Literal["ok"]
    data: AskData


class ValidationIssue(BaseModel):
    location: list[str | int]
    message: str
    type: str


class BackendErrorResult(BaseModel):
    status: Literal["error"]
    errorCode: BackendErrorCode
    message: str
    issues: list[ValidationIssue] = Field(default_factory=list)


def _validate_chat_identifier_text(value: str, label: str, maximum: int) -> None:
    if (
        value != value.strip()
        or _utf16_character_count(value) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError(f"{label} is invalid")


def _validate_chat_content(
    value: str,
    label: str,
    maximum: int,
    *,
    allow_empty: bool,
) -> None:
    if (
        (not allow_empty and not value.strip())
        or _utf16_character_count(value) > maximum
        or "\0" in value
    ):
        raise ValueError(f"{label} is invalid")
