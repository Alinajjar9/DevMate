import json
from typing import Literal

from pydantic import BaseModel, Field, model_validator


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
]
DEVMATE_BACKEND_CAPABILITIES: tuple[BackendCapability, ...] = (
    "chat",
    "streaming",
    "request-authentication",
    "strict-response-contracts",
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
