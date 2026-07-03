import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from .code_changes import CodeChangeParseError, parse_code_change_response
from .prompts import AssistantMode, ScopeType, build_chat_messages
from .providers import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatProvider,
    ChatToolDefinition,
    OpenAICompatibleProvider,
    ProviderError,
    ProviderName,
    ReasoningEffort,
)
from .text_tool_calls import (
    classify_text_tool_call_prefix,
    looks_like_text_tool_call,
    parse_text_tool_calls,
)


logger = logging.getLogger(__name__)


DEVMATE_BACKEND_VERSION = "1.0.0"
ContextSource = Literal["file", "selection", "attachment"]
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


AGENT_TOOL_DEFINITIONS = (
    ChatToolDefinition(
        name="list_files",
        description="List eligible workspace text files, optionally below a relative directory.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional path relative to the open workspace. Do not include the workspace folder name. Use an empty string for the project root.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 500,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="read_file",
        description="Read one eligible text file using its workspace-relative path.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path relative to the open workspace; never an absolute path.",
                },
                "startLine": {"type": "integer", "minimum": 1},
                "endLine": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="search_code",
        description="Search eligible project text files for a plain-text query and return matching lines.",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 2, "maxLength": 200},
                "path": {
                    "type": "string",
                    "description": "Optional file or directory relative to the open workspace. Do not include the workspace folder name.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200,
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="get_symbols",
        description=(
            "Read the structural symbols declared in one workspace file through VS Code's language provider. "
            "Returns symbol kinds, names, containers, and one-based source positions."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="find_definition",
        description=(
            "Find workspace definitions for the symbol at a one-based line and column using VS Code's language provider. "
            "Use read_file or search_code first to identify the source position."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "line": {"type": "integer", "minimum": 1},
                "column": {"type": "integer", "minimum": 1},
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path", "line", "column"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="find_references",
        description=(
            "Find workspace references for the symbol at a one-based line and column using VS Code's language provider. "
            "Use read_file or search_code first to identify the source position."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "line": {"type": "integer", "minimum": 1},
                "column": {"type": "integer", "minimum": 1},
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path", "line", "column"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="get_diagnostics",
        description=(
            "Read current VS Code Problems diagnostics for workspace files. "
            "Returns errors and warnings with workspace-relative paths and positions."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative file or directory. Use an empty string for the entire workspace.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="read_terminal_errors",
        description=(
            "Read recent failed commands captured from user terminals in the current workspace. "
            "Only failures observed after DevMate activation through VS Code Terminal Shell Integration are available."
        ),
        parameters={
            "type": "object",
            "properties": {
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="create_file",
        description=(
            "Create one new eligible workspace text file, automatically creating missing parent directories. "
            "Use complete file content and never use this for an existing file or create placeholder .gitkeep files."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "New file path relative to the open workspace; never an absolute path.",
                },
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="edit_file",
        description=(
            "Edit an existing text file with 1-20 sequential exact replacements. Each oldText must match exactly once."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace; never an absolute path.",
                },
                "replacements": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": {"type": "string", "minLength": 1},
                            "newText": {"type": "string"},
                        },
                        "required": ["oldText", "newText"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["path", "replacements"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="delete_file",
        description=(
            "Delete one existing eligible workspace text file. Use only when removal is necessary. "
            "The extension always asks the user for one-time approval and does not delete directories."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace; never an absolute path.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="rename_file",
        description=(
            "Rename one existing eligible workspace text file within its current directory. "
            "The destination must not exist and the extension always asks for one-time approval."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace.",
                },
                "newPath": {
                    "type": "string",
                    "description": "New file path in the same directory, relative to the open workspace.",
                },
            },
            "required": ["path", "newPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="move_file",
        description=(
            "Move one existing eligible workspace text file to a different workspace-relative path. "
            "Missing destination directories are created automatically. The destination must not exist and the "
            "extension always asks for one-time approval. Never use run_command with move, mv, or mkdir."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace.",
                },
                "newPath": {
                    "type": "string",
                    "description": "Destination file path relative to the open workspace.",
                },
            },
            "required": ["path", "newPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="install_dependencies",
        description=(
            "Install Python dependencies from one validated requirements*.txt manifest into a project-local virtual "
            "environment. Use only after verification reports a missing dependency. This always requires explicit "
            "user approval; never use run_command for pip or package installation."
        ),
        parameters={
            "type": "object",
            "properties": {
                "manifestPath": {
                    "type": "string",
                    "description": "Path to requirements.txt or requirements-*.txt relative to the open workspace.",
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 1800,
                },
            },
            "required": ["manifestPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="run_command",
        description=(
            "Run one approved verification command such as a test, lint, type-check, or build command. "
            "Installation, Git, shells, servers, generators, and writable formatters are blocked. "
            "If pytest is unavailable, convert the tests to Python unittest and run "
            "python -m unittest <test-file> -v instead of trying to install pytest."
        ),
        parameters={
            "type": "object",
            "properties": {
                "executable": {"type": "string"},
                "args": {
                    "type": "array",
                    "maxItems": 50,
                    "items": {"type": "string", "maxLength": 500},
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory relative to the open workspace. Use '.' for the workspace root and do not include the workspace folder name.",
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 1800,
                },
            },
            "required": ["executable"],
            "additionalProperties": False,
        },
    ),
)


app = FastAPI(title="DevMate Backend", version=DEVMATE_BACKEND_VERSION)
_chat_provider = OpenAICompatibleProvider()


def get_chat_provider() -> ChatProvider:
    return _chat_provider


@app.exception_handler(RequestValidationError)
async def request_validation_error(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    issues = [
        {
            "loc": [part for part in item.get("loc", ()) if isinstance(part, (str, int))],
            "msg": str(item.get("msg", "Invalid value"))[:240],
            "type": str(item.get("type", "value_error"))[:120],
        }
        for item in error.errors()[:8]
    ]
    summary = "; ".join(
        f"{'.'.join(str(part) for part in issue['loc'])}: {issue['msg']}"
        for issue in issues[:4]
    )
    logger.warning("Rejected %s request validation: %s", request.url.path, summary)
    return JSONResponse(status_code=422, content={"detail": issues})


@app.get("/health", response_model=HealthResult)
async def health() -> HealthResult:
    return HealthResult(
        status="ok",
        data=HealthData(backend="online", version=app.version),
    )


@app.post("/ask", response_model=AskResult)
async def ask(
    request: AskRequest,
    chat_provider: Annotated[ChatProvider, Depends(get_chat_provider)],
    provider_api_key: Annotated[
        str | None,
        Header(alias="X-DevMate-Provider-Key", max_length=10_000),
    ] = None,
) -> AskResult:
    completion_request, enabled_tools, used_files = _build_completion_request(
        request,
        provider_api_key,
    )
    try:
        completion_value = await chat_provider.complete(completion_request)
    except ProviderError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    completion = completion_value if isinstance(completion_value, ChatCompletion) else ChatCompletion(
        content=completion_value
    )
    return _ask_result_from_completion(
        request,
        completion,
        enabled_tools,
        used_files,
        _completion_token_usage(completion_request, completion),
    )


@app.post("/ask/stream")
async def ask_stream(
    request: AskRequest,
    chat_provider: Annotated[ChatProvider, Depends(get_chat_provider)],
    provider_api_key: Annotated[
        str | None,
        Header(alias="X-DevMate-Provider-Key", max_length=10_000),
    ] = None,
) -> StreamingResponse:
    completion_request, enabled_tools, used_files = _build_completion_request(
        request,
        provider_api_key,
    )

    async def event_stream() -> AsyncIterator[str]:
        yield _stream_line({"type": "start"})
        initial_usage = _completion_token_usage(completion_request, None)
        yield _stream_line({"type": "usage", "usage": initial_usage.model_dump(mode="json")})
        completion: ChatCompletion | None = None
        reasoning_announced = False
        tool_announced = False
        preview_mode: Literal["pending", "answer", "tool"] = "pending"
        preview_buffer = ""
        try:
            stream_method = getattr(chat_provider, "stream", None)
            if callable(stream_method):
                async for event in stream_method(completion_request):
                    if event.kind == "content" and event.text:
                        if preview_mode == "answer":
                            yield _stream_line({"type": "delta", "text": event.text})
                        elif preview_mode == "pending":
                            preview_buffer += event.text
                            preview_mode = classify_text_tool_call_prefix(preview_buffer)
                            if preview_mode == "answer":
                                yield _stream_line({"type": "delta", "text": preview_buffer})
                                preview_buffer = ""
                            elif preview_mode == "tool":
                                preview_buffer = ""
                                if not tool_announced:
                                    tool_announced = True
                                    yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
                    elif event.kind == "reasoning" and not reasoning_announced:
                        reasoning_announced = True
                        yield _stream_line({"type": "progress", "phase": "Model is reasoning"})
                    elif event.kind == "tool":
                        if not tool_announced:
                            tool_announced = True
                            yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
                    elif event.kind == "complete" and event.completion:
                        completion = event.completion
            else:
                completion_value = await chat_provider.complete(completion_request)
                completion = completion_value if isinstance(completion_value, ChatCompletion) else ChatCompletion(
                    content=completion_value
                )
                if completion.content:
                    preview_buffer = completion.content
                    preview_mode = classify_text_tool_call_prefix(preview_buffer)

            if not completion:
                raise HTTPException(
                    status_code=502,
                    detail="The model provider ended its stream without a final response.",
                )
            completion, converted_text_tool = _normalize_text_tool_completion(completion)
            if converted_text_tool and not tool_announced:
                tool_announced = True
                yield _stream_line({"type": "progress", "phase": "Preparing project tool call"})
            if preview_mode == "pending" and preview_buffer and not converted_text_tool:
                yield _stream_line({"type": "delta", "text": preview_buffer})
            elif preview_mode == "answer" and preview_buffer:
                yield _stream_line({"type": "delta", "text": preview_buffer})
            result = _ask_result_from_completion(
                request,
                completion,
                enabled_tools,
                used_files,
                _completion_token_usage(completion_request, completion),
            )
            yield _stream_line({"type": "final", "result": result.model_dump(mode="json")})
        except ProviderError as error:
            yield _stream_line({
                "type": "error",
                "message": str(error),
                "statusCode": error.status_code,
                "errorKind": "http",
            })
        except HTTPException as error:
            yield _stream_line({
                "type": "error",
                "message": str(error.detail),
                "statusCode": error.status_code,
                "errorKind": "http",
            })
        except Exception:
            logger.exception("Streamed provider request failed unexpectedly")
            yield _stream_line({
                "type": "error",
                "message": "The DevMate backend could not complete the streamed request.",
                "statusCode": 500,
                "errorKind": "http",
            })

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _build_completion_request(
    request: AskRequest,
    provider_api_key: str | None,
) -> tuple[ChatCompletionRequest, tuple[AgentToolName, ...], list[str]]:
    used_files = _used_files(request.scope)
    api_key = provider_api_key.strip() if provider_api_key else None
    requested_tools = (
        tuple(request.enabledTools)
        if request.enabledTools is not None
        else READ_ONLY_AGENT_TOOLS if request.toolsEnabled else ()
    )
    mode_tools = READ_ONLY_AGENT_TOOLS if request.mode == "ideas" else (
        *READ_ONLY_AGENT_TOOLS,
        *MUTATING_AGENT_TOOLS,
    )
    enabled_tools = tuple(
        tool for tool in requested_tools if tool in mode_tools
    ) if not request.forceFinalAnswer else ()
    tools_enabled = bool(enabled_tools)
    messages = build_chat_messages(
        mode=request.mode,
        scope_type=request.scope.type,
        question=request.question,
        context_items=request.scope.items,
        tool_steps=request.toolHistory,
        tools_enabled=tools_enabled,
        force_final_answer=request.forceFinalAnswer,
        disable_thinking=request.disableThinking,
        agent_edits_enabled=request.agentEditsEnabled,
        conversation_turns=request.conversationHistory,
    )
    return ChatCompletionRequest(
        provider=request.settings.provider,
        model=request.settings.model,
        base_url=request.settings.baseUrl,
        api_key=api_key if request.settings.provider == "openai" else None,
        messages=messages,
        max_tokens=request.settings.maxTokens,
        temperature=request.settings.temperature,
        reasoning_effort=request.settings.reasoningEffort,
        timeout_seconds=request.settings.timeoutSeconds,
        tools=tuple(
            definition
            for definition in AGENT_TOOL_DEFINITIONS
            if definition.name in enabled_tools
        ),
        force_final_answer=request.forceFinalAnswer,
        disable_thinking=request.disableThinking,
    ), enabled_tools, used_files


def _ask_result_from_completion(
    request: AskRequest,
    completion: ChatCompletion,
    enabled_tools: tuple[AgentToolName, ...],
    used_files: list[str],
    token_usage: TokenUsage,
) -> AskResult:
    completion, _ = _normalize_text_tool_completion(completion)
    tools_enabled = bool(enabled_tools)
    if completion.tool_calls:
        if not tools_enabled:
            raise HTTPException(
                status_code=502,
                detail="The model requested another tool when DevMate required a final answer.",
            )
        tool_calls = _parse_agent_tool_calls(completion.tool_calls, set(enabled_tools))
        history_call_ids = {step.callId for step in request.toolHistory}
        if any(tool_call.id in history_call_ids for tool_call in tool_calls):
            raise HTTPException(status_code=502, detail="The model reused an invalid tool-call id.")
        return AskResult(
            status="ok",
            data=AskData(
                answer="",
                usedFiles=used_files,
                toolCalls=tool_calls,
                tokenUsage=token_usage,
            ),
        )

    answer = completion.content
    if not answer:
        if completion.reasoning_content or completion.finish_reason in {"length", "max_tokens"}:
            raise HTTPException(
                status_code=502,
                detail=(
                    "The model used its response budget for reasoning without producing "
                    "a final answer. Increase devMate.maxTokens or try again."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail="The model provider returned an empty final answer.",
        )

    changes: list[FileChange] = []
    if request.mode == "code" and not request.agentEditsEnabled:
        try:
            answer, parsed_changes = parse_code_change_response(answer)
        except CodeChangeParseError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        changes = [
            FileChange(path=change.path, content=change.content)
            for change in parsed_changes
        ]

    return AskResult(
        status="ok",
        data=AskData(
            answer=answer,
            usedFiles=used_files,
            changes=changes,
            tokenUsage=token_usage,
        ),
    )


def _normalize_text_tool_completion(
    completion: ChatCompletion,
) -> tuple[ChatCompletion, bool]:
    if completion.tool_calls or not completion.content:
        return completion, False
    if not looks_like_text_tool_call(completion.content):
        return completion, False
    tool_calls = parse_text_tool_calls(completion.content)
    if not tool_calls:
        raise HTTPException(
            status_code=502,
            detail="The model returned a malformed textual tool call.",
        )
    return ChatCompletion(
        content=None,
        tool_calls=tool_calls,
        finish_reason=completion.finish_reason,
        reasoning_content=completion.reasoning_content,
        usage=completion.usage,
    ), True


def _completion_token_usage(
    request: ChatCompletionRequest,
    completion: ChatCompletion | None,
) -> TokenUsage:
    if completion and completion.usage:
        return TokenUsage(
            inputTokens=completion.usage.input_tokens,
            outputTokens=completion.usage.output_tokens,
            totalTokens=completion.usage.total_tokens,
            exact=True,
        )

    input_characters = 0
    for message in request.messages:
        input_characters += len(message.role) + len(message.content or "")
        input_characters += len(message.tool_call_id or "")
        for tool_call in message.tool_calls:
            input_characters += len(tool_call.id) + len(tool_call.name) + len(tool_call.arguments)
    for tool in request.tools:
        input_characters += len(tool.name) + len(tool.description)
        input_characters += len(json.dumps(tool.parameters, separators=(",", ":"), ensure_ascii=False))

    output_characters = 0
    if completion:
        output_characters += len(completion.content or "")
        output_characters += len(completion.reasoning_content or "")
        for tool_call in completion.tool_calls:
            output_characters += len(tool_call.id) + len(tool_call.name) + len(tool_call.arguments)
    input_tokens = _estimated_token_count(input_characters)
    output_tokens = _estimated_token_count(output_characters)
    return TokenUsage(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=input_tokens + output_tokens,
        exact=False,
    )


def _estimated_token_count(character_count: int) -> int:
    return 0 if character_count <= 0 else max(1, (character_count + 3) // 4)


def _stream_line(value: dict[str, object]) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"


def _parse_agent_tool_calls(
    tool_calls: tuple[object, ...],
    enabled_tools: set[AgentToolName],
) -> list[AgentToolCall]:
    parsed_calls: list[AgentToolCall] = []
    seen_ids: set[str] = set()
    for tool_call in tool_calls:
        call_id = getattr(tool_call, "id", "")
        name = getattr(tool_call, "name", "")
        arguments_json = getattr(tool_call, "arguments", "")
        if (
            not isinstance(call_id, str)
            or not call_id
            or len(call_id) > 120
            or call_id in seen_ids
            or name not in enabled_tools
            or not isinstance(arguments_json, str)
            or len(arguments_json) > 1_200_000
        ):
            raise HTTPException(status_code=502, detail="The model requested an invalid tool.")
        try:
            arguments = json.loads(arguments_json)
        except (TypeError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=502, detail="The model returned invalid tool arguments.") from error
        if not isinstance(arguments, dict):
            raise HTTPException(status_code=502, detail="The model returned invalid tool arguments.")
        seen_ids.add(call_id)
        parsed_calls.append(
            AgentToolCall(id=call_id, name=name, arguments=arguments)
        )
    return parsed_calls


def _used_files(scope: AskScope) -> list[str]:
    return list(dict.fromkeys(item.filePath for item in scope.items))
