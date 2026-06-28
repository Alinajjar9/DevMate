from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field


AssistantMode = Literal["ideas", "code", "debug"]
ScopeType = Literal["project", "file", "selection"]


class LlmSettings(BaseModel):
    provider: str
    model: str
    maxTokens: int = Field(ge=128, le=8_000)
    temperature: float = Field(ge=0, le=2)


class AskScope(BaseModel):
    type: ScopeType
    workspacePath: str | None = None
    filePath: str | None = None
    selectedText: str | None = None
    selectedCharacters: int | None = Field(default=None, ge=0)


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


app = FastAPI(title="DevMate Backend", version="0.1.0")


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
    if scope.type in {"file", "selection"} and scope.filePath:
        return [scope.filePath]
    return []


def _build_deterministic_answer(request: AskRequest) -> str:
    selected_characters = request.scope.selectedCharacters
    if selected_characters is None and request.scope.selectedText is not None:
        selected_characters = len(request.scope.selectedText)

    lines = [
        f"Mode: {request.mode}",
        f"Scope: {request.scope.type}",
        f"Provider: {request.settings.provider}",
        f"Model: {request.settings.model}",
        f"Max tokens: {request.settings.maxTokens}",
        f"Temperature: {request.settings.temperature}",
    ]
    if selected_characters is not None:
        lines.append(f"Selected context: {selected_characters} characters")

    lines.extend(
        [
            "",
            f"Question: {request.question}",
            "",
            "Deterministic response from the local DevMate backend. A real LLM is not connected yet.",
        ]
    )
    return "\n".join(lines)
