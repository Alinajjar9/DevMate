from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, model_validator

from .prompts import AssistantMode, ScopeType, build_chat_messages
from .providers import (
    ChatCompletionRequest,
    ChatProvider,
    OpenAICompatibleProvider,
    ProviderError,
    ProviderName,
)


ContextSource = Literal["file", "selection", "attachment"]
MAX_CONTEXT_CHARACTERS = 20_000
MAX_PROJECT_CONTEXT_FILES = 5
MAX_PROJECT_FILE_CHARACTERS = 8_000
MAX_PROJECT_CONTEXT_CHARACTERS = 40_000
MAX_ATTACHED_FILES = 5
MAX_REQUEST_CONTEXT_ITEMS = 6
MAX_REQUEST_CONTEXT_CHARACTERS = 40_000


def _utf16_character_count(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


class LlmSettings(BaseModel):
    provider: ProviderName
    model: str = Field(min_length=1, max_length=120)
    baseUrl: str | None = Field(default=None, max_length=2_048)
    maxTokens: int = Field(ge=128, le=8_000)
    temperature: float = Field(ge=0, le=2)


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


class AskRequest(BaseModel):
    question: str = Field(min_length=1)
    mode: AssistantMode
    scope: AskScope
    settings: LlmSettings


class HealthData(BaseModel):
    backend: Literal["online"]
    version: str


class HealthResult(BaseModel):
    status: Literal["ok"]
    data: HealthData


class AskData(BaseModel):
    answer: str
    usedFiles: list[str]


class AskResult(BaseModel):
    status: Literal["ok"]
    data: AskData


app = FastAPI(title="DevMate Backend", version="0.5.0")
_chat_provider = OpenAICompatibleProvider()


def get_chat_provider() -> ChatProvider:
    return _chat_provider


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
    used_files = _used_files(request.scope)
    api_key = provider_api_key.strip() if provider_api_key else None
    messages = build_chat_messages(
        mode=request.mode,
        scope_type=request.scope.type,
        question=request.question,
        context_items=request.scope.items,
    )
    try:
        answer = await chat_provider.complete(
            ChatCompletionRequest(
                provider=request.settings.provider,
                model=request.settings.model,
                base_url=request.settings.baseUrl,
                api_key=api_key if request.settings.provider == "openai" else None,
                messages=messages,
                max_tokens=request.settings.maxTokens,
                temperature=request.settings.temperature,
            )
        )
    except ProviderError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    return AskResult(
        status="ok",
        data=AskData(
            answer=answer,
            usedFiles=used_files,
        ),
    )


def _used_files(scope: AskScope) -> list[str]:
    return list(dict.fromkeys(item.filePath for item in scope.items))
