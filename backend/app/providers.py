from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx


ProviderName = Literal["openai", "ollama"]
MessageRole = Literal["system", "user", "assistant"]
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
PROVIDER_TIMEOUT_SECONDS = 90.0


@dataclass(frozen=True)
class ChatMessage:
    role: MessageRole
    content: str


@dataclass(frozen=True)
class ChatCompletionRequest:
    provider: ProviderName
    model: str
    base_url: str | None
    api_key: str | None
    messages: tuple[ChatMessage, ...]
    max_tokens: int
    temperature: float


class ChatProvider(Protocol):
    async def complete(self, request: ChatCompletionRequest) -> str: ...


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

    async def complete(self, request: ChatCompletionRequest) -> str:
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
            "messages": [
                {"role": message.role, "content": message.content}
                for message in request.messages
            ],
            "temperature": request.temperature,
            "stream": False,
        }
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

        answer = _read_answer(response_payload)
        if not answer:
            raise ProviderError(
                "The model provider returned an empty or invalid answer.",
                502,
            )
        return answer


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


def _read_answer(payload: object) -> str | None:
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
    content = message.get("content")
    if not isinstance(content, str):
        return None
    return content.strip() or None
