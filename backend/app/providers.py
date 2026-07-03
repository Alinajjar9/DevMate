from dataclasses import dataclass
import json
import os
from collections.abc import AsyncIterator
from typing import Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx


ProviderName = Literal["openai", "ollama"]
ReasoningEffort = Literal["auto", "low", "medium", "high", "xhigh"]
MessageRole = Literal["system", "user", "assistant", "tool"]
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 900.0
MIN_PROVIDER_TIMEOUT_SECONDS = 10.0
MAX_PROVIDER_TIMEOUT_SECONDS = 1_800.0
MAX_REASONING_DIAGNOSTIC_CHARACTERS = 1_000
MAX_TOOL_ARGUMENT_CHARACTERS = 1_200_000


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
    usage: "ChatTokenUsage | None" = None


@dataclass(frozen=True)
class ChatTokenUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class ChatCompletionRequest:
    provider: ProviderName
    model: str
    base_url: str | None
    api_key: str | None
    messages: tuple[ChatMessage, ...]
    max_tokens: int
    temperature: float
    reasoning_effort: ReasoningEffort = "auto"
    timeout_seconds: float | None = None
    tools: tuple[ChatToolDefinition, ...] = ()
    force_final_answer: bool = False
    disable_thinking: bool = False


@dataclass(frozen=True)
class ChatStreamEvent:
    kind: Literal["content", "reasoning", "tool", "complete"]
    text: str | None = None
    completion: ChatCompletion | None = None


class ChatProvider(Protocol):
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion | str: ...


class ProviderError(Exception):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _provider_request_parts(
    request: ChatCompletionRequest,
    *,
    stream: bool,
) -> tuple[str, dict[str, str], dict[str, object]]:
    endpoint = create_chat_completions_url(request.base_url, request.provider)
    headers = {
        "Accept": "text/event-stream" if stream else "application/json",
        "Content-Type": "application/json",
    }
    if request.api_key:
        headers["Authorization"] = f"Bearer {request.api_key}"

    payload: dict[str, object] = {
        "model": request.model,
        "messages": [_serialize_message(message) for message in request.messages],
        "temperature": request.temperature,
        "stream": stream,
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
        thinking_enabled = (
            not request.force_final_answer
            and not request.disable_thinking
        )
        payload["chat_template_kwargs"] = {
            "enable_thinking": thinking_enabled,
            "force_nonempty_content": True,
        }
        if thinking_enabled:
            if request.reasoning_effort == "medium":
                payload["chat_template_kwargs"]["medium_effort"] = True
            elif request.reasoning_effort == "high":
                pass
            else:
                payload["reasoning_budget"] = _nemotron_reasoning_budget(
                    request.max_tokens,
                    request.reasoning_effort,
                )
    elif (
        request.reasoning_effort != "auto"
        and _supports_openai_reasoning_effort(request)
    ):
        payload["reasoning_effort"] = request.reasoning_effort
    if _is_official_openai_endpoint(request):
        payload["max_completion_tokens"] = request.max_tokens
    else:
        payload["max_tokens"] = request.max_tokens
    return endpoint, headers, payload


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

        endpoint, headers, payload = _provider_request_parts(request, stream=False)

        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=request.timeout_seconds or self._timeout_seconds,
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

    async def stream(self, request: ChatCompletionRequest) -> AsyncIterator[ChatStreamEvent]:
        if request.provider == "openai" and not request.api_key:
            raise ProviderError("The selected model profile is missing an API key.", 400)

        endpoint, headers, payload = _provider_request_parts(request, stream=True)
        # Keep the final completion while forwarding small content events to the extension.
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        streamed_tool_calls: dict[int, dict[str, str]] = {}
        streamed_usage: ChatTokenUsage | None = None
        finish_reason: str | None = None
        tool_announced = False
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=request.timeout_seconds or self._timeout_seconds,
                follow_redirects=False,
            ) as client:
                async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                    if response.is_redirect:
                        raise ProviderError(
                            "The model provider returned a redirect. Check the profile base URL.",
                            502,
                        )
                    if response.status_code >= 400:
                        await response.aread()
                        raise _provider_http_error(response)

                    content_type = response.headers.get("content-type", "").casefold()
                    if "text/event-stream" not in content_type:
                        raw_response = await response.aread()
                        try:
                            response_payload = json.loads(raw_response)
                        except (TypeError, ValueError) as error:
                            raise ProviderError(
                                "The model provider returned a non-streaming invalid response.",
                                502,
                            ) from error
                        completion = _read_completion(response_payload)
                        if not completion:
                            raise ProviderError(
                                "The model provider returned an empty or invalid answer.",
                                502,
                            )
                        if completion.content:
                            yield ChatStreamEvent(kind="content", text=completion.content)
                        yield ChatStreamEvent(kind="complete", completion=completion)
                        return

                    async for line in response.aiter_lines():
                        normalized = line.strip()
                        if not normalized or normalized.startswith(":"):
                            continue
                        if not normalized.startswith("data:"):
                            continue
                        data = normalized[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except ValueError as error:
                            raise ProviderError(
                                "The model provider returned an invalid streaming event.",
                                502,
                            ) from error
                        chunk_usage = _read_token_usage(chunk)
                        if chunk_usage:
                            streamed_usage = chunk_usage
                        choice = _first_stream_choice(chunk)
                        if choice is None:
                            continue
                        raw_finish_reason = choice.get("finish_reason")
                        if isinstance(raw_finish_reason, str) and raw_finish_reason.strip():
                            finish_reason = raw_finish_reason.strip()[:120]
                        delta = choice.get("delta")
                        if not isinstance(delta, dict):
                            continue
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            content_parts.append(content)
                            yield ChatStreamEvent(kind="content", text=content)
                        reasoning = delta.get("reasoning_content")
                        if isinstance(reasoning, str) and reasoning:
                            reasoning_parts.append(reasoning)
                            yield ChatStreamEvent(kind="reasoning")
                        raw_tool_calls = delta.get("tool_calls")
                        _append_stream_tool_calls(streamed_tool_calls, raw_tool_calls)
                        if isinstance(raw_tool_calls, list) and raw_tool_calls and not tool_announced:
                            tool_announced = True
                            yield ChatStreamEvent(kind="tool")
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

        completion = _stream_completion(
            content_parts,
            reasoning_parts,
            streamed_tool_calls,
            finish_reason,
            streamed_usage,
        )
        if not completion:
            raise ProviderError("The model provider returned an empty or invalid answer.", 502)
        yield ChatStreamEvent(kind="complete", completion=completion)


def _first_stream_choice(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    choices = value.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    return choices[0]


def _append_stream_tool_calls(
    target: dict[int, dict[str, str]],
    value: object,
) -> None:
    if not isinstance(value, list) or len(value) > 3:
        return
    for fallback_index, raw_call in enumerate(value):
        if not isinstance(raw_call, dict):
            continue
        raw_index = raw_call.get("index", fallback_index)
        if not isinstance(raw_index, int) or raw_index < 0 or raw_index > 2:
            continue
        current = target.setdefault(raw_index, {"id": "", "name": "", "arguments": ""})
        call_id = raw_call.get("id")
        if isinstance(call_id, str):
            current["id"] += call_id
        function = raw_call.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        arguments = function.get("arguments")
        if isinstance(name, str):
            current["name"] += name
        if isinstance(arguments, str):
            current["arguments"] += arguments
            if len(current["arguments"]) > MAX_TOOL_ARGUMENT_CHARACTERS:
                raise ProviderError("The model provider streamed oversized tool arguments.", 502)


def _stream_completion(
    content_parts: list[str],
    reasoning_parts: list[str],
    streamed_tool_calls: dict[int, dict[str, str]],
    finish_reason: str | None,
    usage: ChatTokenUsage | None,
) -> ChatCompletion | None:
    tool_calls: list[ChatToolCall] = []
    for index in sorted(streamed_tool_calls):
        value = streamed_tool_calls[index]
        call_id = value["id"].strip()
        name = value["name"].strip()
        arguments = value["arguments"]
        if not call_id or len(call_id) > 120 or not name or len(name) > 120:
            return None
        tool_calls.append(ChatToolCall(id=call_id, name=name, arguments=arguments))
    content = "".join(content_parts).strip() or None
    reasoning = "".join(reasoning_parts).strip()[:MAX_REASONING_DIAGNOSTIC_CHARACTERS] or None
    if not content and not tool_calls and not reasoning and not finish_reason:
        return None
    return ChatCompletion(
        content=content,
        tool_calls=tuple(tool_calls),
        finish_reason=finish_reason,
        reasoning_content=reasoning,
        usage=usage,
    )


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


def _nemotron_reasoning_budget(
    max_tokens: int,
    effort: ReasoningEffort = "auto",
) -> int:
    divisor = 4 if effort == "low" else 2
    return max(64, min(max_tokens - 64, max_tokens // divisor))


def _is_official_openai_endpoint(request: ChatCompletionRequest) -> bool:
    if request.provider != "openai":
        return False
    if request.base_url is None:
        return True
    try:
        return urlsplit(request.base_url).hostname == "api.openai.com"
    except ValueError:
        return False


def _supports_openai_reasoning_effort(request: ChatCompletionRequest) -> bool:
    if not _is_official_openai_endpoint(request):
        return False
    model = request.model.casefold()
    is_reasoning_model = (
        model == "gpt-5"
        or model.startswith(("gpt-5-", "gpt-5."))
        or model.startswith(("o1-", "o3-", "o4-"))
        or model in {"o1", "o3", "o4"}
    )
    if not is_reasoning_model:
        return False
    if "-pro" in model:
        return request.reasoning_effort == "high"
    if request.reasoning_effort != "xhigh":
        return True
    version = model.removeprefix("gpt-5.").split("-", 1)[0]
    return version.isdigit() and int(version) >= 2


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
            or len(arguments) > MAX_TOOL_ARGUMENT_CHARACTERS
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
        usage=_read_token_usage(payload),
    )


def _read_token_usage(payload: object) -> ChatTokenUsage | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("usage"), dict):
        return None
    usage = payload["usage"]
    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
    output_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
    total_tokens = usage.get("total_tokens")
    if (
        not isinstance(input_tokens, int)
        or isinstance(input_tokens, bool)
        or not isinstance(output_tokens, int)
        or isinstance(output_tokens, bool)
        or input_tokens < 0
        or output_tokens < 0
        or input_tokens > 100_000_000
        or output_tokens > 100_000_000
    ):
        return None
    expected_total = input_tokens + output_tokens
    if (
        not isinstance(total_tokens, int)
        or isinstance(total_tokens, bool)
        or total_tokens < expected_total
        or total_tokens > 200_000_000
    ):
        total_tokens = expected_total
    return ChatTokenUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
    )
