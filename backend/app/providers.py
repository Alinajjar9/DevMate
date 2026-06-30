from dataclasses import dataclass
import os
from typing import Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx


ProviderName = Literal["openai", "ollama"]
MessageRole = Literal["system", "user", "assistant", "tool"]
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 300.0
MIN_PROVIDER_TIMEOUT_SECONDS = 10.0
MAX_PROVIDER_TIMEOUT_SECONDS = 1_800.0
MAX_REASONING_DIAGNOSTIC_CHARACTERS = 1_000


def parse_provider_timeout_seconds(value: str | None) -> float:
    if value is None:
        return DEFAULT_PROVIDER_TIMEOUT_SECONDS

    try:
        timeout_seconds = float(value)
    except ValueError:
        return DEFAULT_PROVIDER_TIMEOUT_SECONDS

    if not MIN_PROVIDER_TIMEOUT_SECONDS <= timeout_seconds <= MAX_PROVIDER_TIMEOUT_SECONDS:
        return DEFAULT_PROVIDER_TIMEOUT_SECONDS
    return timeout_seconds


PROVIDER_TIMEOUT_SECONDS = parse_provider_timeout_seconds(
    os.getenv("DEVMATE_PROVIDER_TIMEOUT_SECONDS")
)


@dataclass(frozen=True)
class ChatToolCall:
    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ChatToolDefinition:
    name: str
    description: str
    parameters: dict[str, object]


@dataclass(frozen=True)
class ChatMessage:
    role: MessageRole
    content: str | None
    tool_calls: tuple[ChatToolCall, ...] = ()
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ChatCompletion:
    content: str | None
    tool_calls: tuple[ChatToolCall, ...] = ()
    finish_reason: str | None = None
    reasoning_content: str | None = None


@dataclass(frozen=True)
class ChatCompletionRequest:
    provider: ProviderName
    model: str
    base_url: str | None
    api_key: str | None
    messages: tuple[ChatMessage, ...]
    max_tokens: int
    temperature: float
    tools: tuple[ChatToolDefinition, ...] = ()
    force_final_answer: bool = False


class ChatProvider(Protocol):
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion | str: ...


class ProviderError(Exception):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class OpenAICompatibleProvider:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = PROVIDER_TIMEOUT_SECONDS,
    ) -> None:
        self._transport = transport
        self._timeout_seconds = timeout_seconds

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        if request.provider == "openai" and not request.api_key:
            raise ProviderError("The selected model profile is missing an API key.", 400)

        endpoint = create_chat_completions_url(request.base_url, request.provider)
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if request.api_key:
            headers["Authorization"] = f"Bearer {request.api_key}"

        payload: dict[str, object] = {
            "model": request.model,
            "messages": [_serialize_message(message) for message in request.messages],
            "temperature": request.temperature,
            "stream": False,
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
            payload["tool_choice"] = "auto"
        if request.model.casefold().startswith("nvidia/nemotron-3-"):
            payload["chat_template_kwargs"] = {
                "enable_thinking": not request.force_final_answer,
                "force_nonempty_content": True,
            }
            if not request.force_final_answer:
                payload["reasoning_budget"] = _nemotron_reasoning_budget(
                    request.max_tokens
                )
        if request.provider == "openai" and request.base_url is None:
            payload["max_completion_tokens"] = request.max_tokens
        else:
            # NVIDIA and Ollama document max_tokens on their OpenAI-compatible APIs.
            payload["max_tokens"] = request.max_tokens

        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=self._timeout_seconds,
                follow_redirects=False,
            ) as client:
                response = await client.post(endpoint, headers=headers, json=payload)
        except httpx.TimeoutException as error:
            raise ProviderError(
                "The model provider timed out before returning an answer.",
                504,
            ) from error
        except httpx.RequestError as error:
            raise ProviderError(
                "DevMate could not reach the configured model provider.",
                502,
            ) from error

        if response.is_redirect:
            raise ProviderError(
                "The model provider returned a redirect. Check the profile base URL.",
                502,
            )
        if response.status_code >= 400:
            raise _provider_http_error(response)

        try:
            response_payload = response.json()
        except ValueError as error:
            raise ProviderError(
                "The model provider returned a non-JSON response.",
                502,
            ) from error

        completion = _read_completion(response_payload)
        if not completion:
            raise ProviderError(
                "The model provider returned an empty or invalid answer.",
                502,
            )
        return completion


def _serialize_message(message: ChatMessage) -> dict[str, object]:
    serialized: dict[str, object] = {
        "role": message.role,
        "content": message.content,
    }
    if message.tool_calls:
        serialized["tool_calls"] = [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": tool_call.arguments,
                },
            }
            for tool_call in message.tool_calls
        ]
    if message.tool_call_id:
        serialized["tool_call_id"] = message.tool_call_id
    return serialized


def _nemotron_reasoning_budget(max_tokens: int) -> int:
    return max(64, min(8_192, max_tokens // 2))


def create_chat_completions_url(
    configured_base_url: str | None,
    provider: ProviderName,
) -> str:
    base_url = configured_base_url or (
        DEFAULT_OPENAI_BASE_URL if provider == "openai" else DEFAULT_OLLAMA_BASE_URL
    )
    parsed = urlsplit(base_url.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ProviderError("The model profile has an invalid base URL.", 400)

    path = parsed.path.rstrip("/")
    if provider == "ollama" and path in {"", "/"}:
        path = "/v1"
    if path.endswith("/chat/completions"):
        endpoint_path = path
    else:
        endpoint_path = f"{path}/chat/completions"

    return urlunsplit((parsed.scheme, parsed.netloc, endpoint_path, "", ""))


def _provider_http_error(response: httpx.Response) -> ProviderError:
    detail = _read_error_detail(response)
    if response.status_code in {401, 403}:
        return ProviderError(
            detail or "The model provider rejected the API key.",
            401,
        )
    if response.status_code == 404:
        return ProviderError(
            detail or "The provider endpoint or selected model was not found.",
            404,
        )
    if response.status_code == 429:
        return ProviderError(
            detail or "The model provider rate limit was reached. Try again shortly.",
            429,
        )
    if 400 <= response.status_code < 500:
        return ProviderError(
            detail or "The model provider rejected the request.",
            400,
        )
    return ProviderError(
        detail or "The model provider is currently unavailable.",
        502,
    )


def _read_error_detail(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return _bounded_detail(error["message"])
    if isinstance(error, str):
        return _bounded_detail(error)
    detail = payload.get("detail")
    if isinstance(detail, str):
        return _bounded_detail(detail)
    return None


def _bounded_detail(value: str) -> str | None:
    normalized = " ".join(value.split())
    return normalized[:500] or None


def _read_completion(payload: object) -> ChatCompletion | None:
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None
    message = first_choice.get("message")
    if not isinstance(message, dict):
        return None
    content_value = message.get("content")
    content = content_value.strip() if isinstance(content_value, str) else None
    finish_reason_value = first_choice.get("finish_reason")
    finish_reason = (
        finish_reason_value.strip()[:120]
        if isinstance(finish_reason_value, str) and finish_reason_value.strip()
        else None
    )
    reasoning_value = message.get("reasoning_content")
    reasoning_content = (
        reasoning_value.strip()[:MAX_REASONING_DIAGNOSTIC_CHARACTERS]
        if isinstance(reasoning_value, str) and reasoning_value.strip()
        else None
    )
    raw_tool_calls = message.get("tool_calls", [])
    if not isinstance(raw_tool_calls, list) or len(raw_tool_calls) > 3:
        return None

    tool_calls: list[ChatToolCall] = []
    for raw_tool_call in raw_tool_calls:
        if not isinstance(raw_tool_call, dict):
            return None
        function = raw_tool_call.get("function")
        call_id = raw_tool_call.get("id")
        if not isinstance(function, dict) or not isinstance(call_id, str):
            return None
        name = function.get("name")
        arguments = function.get("arguments")
        if (
            not call_id.strip()
            or len(call_id) > 120
            or not isinstance(name, str)
            or not name.strip()
            or len(name) > 120
            or not isinstance(arguments, str)
            or len(arguments) > 4_000
        ):
            return None
        tool_calls.append(
            ChatToolCall(
                id=call_id.strip(),
                name=name.strip(),
                arguments=arguments,
            )
        )

    if not content and not tool_calls and not reasoning_content and not finish_reason:
        return None
    return ChatCompletion(
        content=content or None,
        tool_calls=tuple(tool_calls),
        finish_reason=finish_reason,
        reasoning_content=reasoning_content,
    )
