from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field, model_validator


AssistantMode = Literal["ideas", "code", "debug"]
ScopeType = Literal["project", "file", "selection"]
ContextSource = Literal["file", "selection"]
MAX_CONTEXT_CHARACTERS = 20_000


def _utf16_character_count(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


class LlmSettings(BaseModel):
    provider: str
    model: str
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
        if self.type == "file" and (
            len(self.items) != 1 or self.items[0].source != "file"
        ):
            raise ValueError("file scope requires exactly one file context item")
        if self.type == "selection" and (
            len(self.items) != 1 or self.items[0].source != "selection"
        ):
            raise ValueError("selection scope requires exactly one selection context item")
        if self.type == "project" and any(item.source != "file" for item in self.items):
            raise ValueError("project scope can only contain file context items")
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


app = FastAPI(title="DevMate Backend", version="0.2.0")


@app.get("/health", response_model=HealthResult)
async def health() -> HealthResult:
    return HealthResult(
        status="ok",
        data=HealthData(backend="online", version=app.version),
    )


@app.post("/ask", response_model=AskResult)
async def ask(request: AskRequest) -> AskResult:
    used_files = _used_files(request.scope)
    return AskResult(
        status="ok",
        data=AskData(
            answer=_build_deterministic_answer(request),
            usedFiles=used_files,
        ),
    )


def _used_files(scope: AskScope) -> list[str]:
    return list(dict.fromkeys(item.filePath for item in scope.items))


def _build_deterministic_answer(request: AskRequest) -> str:
    lines = [
        f"Mode: {request.mode}",
        f"Scope: {request.scope.type}",
        f"Provider: {request.settings.provider}",
        f"Model: {request.settings.model}",
        f"Max tokens: {request.settings.maxTokens}",
        f"Temperature: {request.settings.temperature}",
    ]
    lines.extend(_context_summary(request.scope))

    lines.extend(
        [
            "",
            f"Question: {request.question}",
            "",
            "Deterministic response from the local DevMate backend. A real LLM is not connected yet.",
        ]
    )
    return "\n".join(lines)


def _context_summary(scope: AskScope) -> list[str]:
    summaries: list[str] = []
    for item in scope.items:
        label = "File context" if item.source == "file" else "Selection context"
        size = (
            f"{item.includedCharacters} of {item.totalCharacters} characters (truncated)"
            if item.truncated
            else f"{item.totalCharacters} characters"
        )
        summaries.append(
            f"{label}: {size} from {item.filePath} [{item.languageId}]"
        )
    return summaries
