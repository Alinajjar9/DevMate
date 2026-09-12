"""Handle OpenAI-compatible HTTP requests and normalize complete or streamed replies."""

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from typing import Literal, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx

from .tool_schemas import function_definition


ProviderName = Literal["openai", "ollama"]
ReasoningEffort = Literal["auto", "none", "low", "medium", "high", "xhigh", "max"]
ProviderApi = Literal["auto", "chat_completions", "responses"]
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
    provider_state: dict[str, object] | None = None


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
    provider_state: dict[str, object] | None = None


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
    api: ProviderApi = "auto"


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
    strict_tools: bool = True,
) -> tuple[str, dict[str, str], dict[str, object]]:
    """Translate DevMate settings into the payload expected by the selected endpoint."""
    if request.provider == "openai" and not request.api_key:
        raise ProviderError("The selected model profile is missing an API key.", 400)

    endpoint = create_provider_url(request.base_url, request.provider, _selected_api(request))
    headers = {
        "Accept": "text/event-stream" if stream else "application/json",
        "Content-Type": "application/json",
    }
    if request.api_key:
        headers["Authorization"] = f"Bearer {request.api_key}"

    if _selected_api(request) == "responses":
        # Import after the shared provider types are defined to keep the adapter separate.
        from .responses import build_responses_payload
        return endpoint, headers, build_responses_payload(request, endpoint, stream=stream, strict_tools=strict_tools)

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
                "function": function_definition(tool.name, tool.description, tool.parameters, strict=strict_tools),
            }
            for tool in request.tools
        ]
        payload["tool_choice"] = "auto"
    # Compatible endpoints share the message format but differ in their reasoning controls.
    if request.model.casefold().startswith("nvidia/nemotron-3-"):
        if request.reasoning_effort in {"xhigh", "max"}:
            raise ProviderError(
                "Nemotron's thinking controls support Auto, Off, Low, Medium, and High. "
                "Choose one of those levels in the intelligence menu.", 400,
            )
        thinking_enabled = (
            not request.force_final_answer
            and not request.disable_thinking
            and request.reasoning_effort != "none"
        )
        payload["chat_template_kwargs"] = {
            "enable_thinking": thinking_enabled,
            "force_nonempty_content": True,
        }
        if thinking_enabled:
            if request.reasoning_effort == "medium":
                payload["chat_template_kwargs"]["medium_effort"] = True
            elif request.reasoning_effort != "high":
                payload["reasoning_budget"] = _nemotron_reasoning_budget(
                    request.max_tokens,
                    request.reasoning_effort,
                )
    elif request.reasoning_effort != "auto":
        # Explicit choices belong to the user. The endpoint validates its supported values.
        payload["reasoning_effort"] = request.reasoning_effort
    # Local and third-party endpoints still use the older token-limit field.
    if _is_official_openai_endpoint(request):
        payload["max_completion_tokens"] = request.max_tokens
    else:
        payload["max_tokens"] = request.max_tokens
    return endpoint, headers, payload


class OpenAICompatibleProvider:
    """Keep provider-specific HTTP handling outside the API routes and prompt builder."""
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = PROVIDER_TIMEOUT_SECONDS,
    ) -> None:
        self._transport = transport
        self._timeout_seconds = timeout_seconds
        # Only remember explicit provider rejections, scoped to a model and exact API endpoint.
        self._compatibility: dict[tuple[str, str], set[str]] = {}

    def _apply_compatibility(
        self, request: ChatCompletionRequest, endpoint: str, payload: dict[str, object],
    ) -> tuple[str, dict[str, object]]:
        known = self._compatibility.get((endpoint, request.model), set())
        if "non_strict" in known:
            payload = _without_strict_tools(request, endpoint, payload, omit_field="omit_strict" in known)
        if "no_temperature" in known:
            payload = {key: value for key, value in payload.items() if key != "temperature"}
        return endpoint, payload

    def _retry_rejected_request(
        self, request: ChatCompletionRequest, response: httpx.Response, endpoint: str,
        payload: dict[str, object], *, stream: bool,
    ) -> tuple[str, dict[str, object]] | None:
        retry = _compatible_retry(request, response, endpoint, payload, stream=stream)
        if retry is None:
            return None
        next_endpoint, next_payload = retry
        if endpoint == next_endpoint:
            key = (endpoint, request.model)
            if key not in self._compatibility and len(self._compatibility) >= 128:
                self._compatibility.pop(next(iter(self._compatibility)))
            known = self._compatibility.setdefault(key, set())
            if "temperature" in payload and "temperature" not in next_payload:
                known.add("no_temperature")
            if _has_strict_tools(payload) and not _has_strict_tools(next_payload):
                known.add("non_strict")
                if not any("strict" in tool.get("function", tool) for tool in next_payload.get("tools", [])):
                    known.add("omit_strict")
        return self._apply_compatibility(request, next_endpoint, next_payload)

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        """Read a full response and turn network or provider failures into consistent errors."""
        endpoint, headers, payload = _provider_request_parts(request, stream=False)
        endpoint, payload = self._apply_compatibility(request, endpoint, payload)

        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=request.timeout_seconds or self._timeout_seconds,
                # Reject redirects instead of silently changing the configured provider endpoint.
                follow_redirects=False,
            ) as client:
                for attempt in range(5):
                    response = await client.post(endpoint, headers=headers, json=payload)
                    retry = self._retry_rejected_request(request, response, endpoint, payload, stream=False)
                    if retry is None or attempt == 4:
                        break
                    endpoint, payload = retry
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

        if endpoint.endswith("/responses"):
            from .responses import read_responses_completion
            completion = read_responses_completion(response_payload, request, endpoint)
        else:
            completion = _read_completion(response_payload)
        if not completion:
            raise ProviderError(
                "The model provider returned an empty or invalid answer.",
                502,
            )
        return completion

    async def stream(self, request: ChatCompletionRequest) -> AsyncIterator[ChatStreamEvent]:
        """Keep the HTTP connection open while forwarding normalized model events."""
        endpoint, headers, payload = _provider_request_parts(request, stream=True)
        endpoint, payload = self._apply_compatibility(request, endpoint, payload)
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=request.timeout_seconds or self._timeout_seconds,
                # Reject redirects instead of silently changing the configured provider endpoint.
                follow_redirects=False,
            ) as client:
                for attempt in range(5):
                    async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                        if response.is_redirect:
                            raise ProviderError(
                                "The model provider returned a redirect. Check the profile base URL.", 502,
                            )
                        if response.status_code >= 400:
                            await response.aread()
                            retry = self._retry_rejected_request(request, response, endpoint, payload, stream=True)
                            if retry is not None and attempt < 4:
                                endpoint, payload = retry
                                continue
                            raise _provider_http_error(response)

                        if endpoint.endswith("/responses"):
                            from .responses import read_responses_events
                            events = read_responses_events(response, request, endpoint)
                        else:
                            events = _read_stream_events(response)
                        async for event in events:
                            yield event
                        return
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


async def _read_stream_events(response: httpx.Response) -> AsyncIterator[ChatStreamEvent]:
    """Forward visible text and progress while also assembling one complete response."""
    content_type = response.headers.get("content-type", "").casefold()
    if "text/event-stream" not in content_type:
        completion = _read_stream_fallback(await response.aread())
        if completion.content:
            yield ChatStreamEvent(kind="content", text=completion.content)
        yield ChatStreamEvent(kind="complete", completion=completion)
        return

    # Accumulate the final response while forwarding content and progress events.
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    streamed_tool_calls: dict[int, dict[str, str]] = {}
    streamed_usage: ChatTokenUsage | None = None
    finish_reason: str | None = None
    tool_announced = False
    async for chunk in _iter_stream_chunks(response):
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
        # Report that reasoning is happening without forwarding its text to the chat.
        reasoning = delta.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning:
            reasoning_parts.append(reasoning)
            yield ChatStreamEvent(kind="reasoning")
        raw_tool_calls = delta.get("tool_calls")
        _append_stream_tool_calls(streamed_tool_calls, raw_tool_calls)
        if isinstance(raw_tool_calls, list) and raw_tool_calls and not tool_announced:
            tool_announced = True
            yield ChatStreamEvent(kind="tool")

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


def _read_stream_fallback(raw_response: bytes) -> ChatCompletion:
    """Accept providers that answer a streaming request with ordinary JSON."""
    try:
        payload = json.loads(raw_response)
    except (TypeError, ValueError) as error:
        raise ProviderError(
            "The model provider returned a non-streaming invalid response.",
            502,
        ) from error
    completion = _read_completion(payload)
    if not completion:
        raise ProviderError("The model provider returned an empty or invalid answer.", 502)
    return completion


async def _iter_stream_chunks(response: httpx.Response) -> AsyncIterator[object]:
    """Decode SSE data lines, ignoring keep-alives and stopping at the provider marker."""
    async for line in response.aiter_lines():
        normalized = line.strip()
        if not normalized.startswith("data:"):
            continue
        data = normalized[5:].strip()
        if data == "[DONE]":
            return
        try:
            yield json.loads(data)
        except ValueError as error:
            raise ProviderError(
                "The model provider returned an invalid streaming event.",
                502,
            ) from error


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
    """Join fragments by call index; argument JSON is incomplete until streaming finishes."""
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
    """Validate the assembled tool calls and keep only a short reasoning diagnostic."""
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
    """Reserve part of the response budget for an answer instead of spending it all on reasoning."""
    divisor = 4 if effort == "low" else 2
    return max(64, min(max_tokens - 64, max_tokens // divisor))


def _is_official_openai_endpoint(request: ChatCompletionRequest) -> bool:
    if request.provider != "openai":
        return False
    if not request.base_url:
        return True
    try:
        return urlsplit(request.base_url).hostname == "api.openai.com"
    except ValueError:
        return False


def _selected_api(request: ChatCompletionRequest) -> Literal["chat_completions", "responses"]:
    """Auto follows the endpoint, never a list of current model names."""
    if request.api != "auto":
        return request.api
    if _is_official_openai_endpoint(request):
        return "responses"
    if request.base_url and urlsplit(request.base_url).path.rstrip("/").endswith("/responses"):
        return "responses"
    responses_url = create_provider_url(request.base_url, request.provider, "responses")
    # An Auto gateway may have requested Responses on an earlier tool turn.
    if any(message.provider_state
           and message.provider_state.get("endpoint") == responses_url
           and message.provider_state.get("model") == request.model
           for message in request.messages):
        return "responses"
    return "chat_completions"


def create_chat_completions_url(configured_base_url: str | None, provider: ProviderName) -> str:
    return create_provider_url(configured_base_url, provider, "chat_completions")


def create_provider_url(
    configured_base_url: str | None,
    provider: ProviderName,
    api: Literal["chat_completions", "responses"],
) -> str:
    """Replace a supplied endpoint suffix so switching API never duplicates URL paths."""
    base_url = configured_base_url or (
        DEFAULT_OPENAI_BASE_URL if provider == "openai" else DEFAULT_OLLAMA_BASE_URL
    )
    try:
        parsed = urlsplit(base_url.strip())
        valid = (parsed.scheme in {"http", "https"} and parsed.hostname
                 and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment)
        parsed.port  # Reject malformed ports before HTTPX handles the URL.
    except ValueError:
        valid = False
    if not valid:
        raise ProviderError("The model profile has an invalid base URL.", 400)
    path = parsed.path.rstrip("/")
    for suffix in ("/chat/completions", "/responses"):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    if not path and (provider == "ollama" or parsed.hostname == "api.openai.com"):
        path = "/v1"
    suffix = "responses" if api == "responses" else "chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, f"{path}/{suffix}", "", ""))


def _compatible_retry(
    request: ChatCompletionRequest,
    response: httpx.Response,
    endpoint: str,
    payload: dict[str, object],
    *,
    stream: bool,
) -> tuple[str, dict[str, object]] | None:
    """Adapt only an explicit HTTP 400 rejection, before any output or tools are accepted.

    Never lower reasoning, remove tools, or retry a partially received answer. API
    switches stay on the configured host, and explicit API selections stay fixed.
    """
    if response.status_code != 400:
        return None
    detail = (_read_error_detail(response) or "").casefold()
    unsupported = any(phrase in detail for phrase in (
        "not supported", "unsupported", "not permitted", "not allowed", "unknown parameter",
        "unrecognized", "extra inputs",
    ))
    schema_bounds = ("minlength", "maxlength", "minitems", "maxitems", "minimum", "maximum")
    if (_has_strict_tools(payload) and unsupported
            and ("strict" in detail or "structured output" in detail
                 or ("schema" in detail and any(bound in detail for bound in schema_bounds)))):
        omit_field = "strict" in detail and any(phrase in detail for phrase in (
            "unknown parameter", "unsupported parameter", "unrecognized", "extra inputs",
        ))
        return endpoint, _without_strict_tools(request, endpoint, payload, omit_field=omit_field)
    if (request.api == "auto" and endpoint.endswith("/chat/completions")
            and ("/responses" in detail or "responses api" in detail)
            and ("tool" in detail or "reasoning" in detail)):
        next_endpoint, _, next_payload = _provider_request_parts(
            replace(request, api="responses"), stream=stream,
        )
        if "temperature" not in payload:
            next_payload.pop("temperature", None)
        return next_endpoint, next_payload
    # Some models reject temperature even though their endpoint supports the field.
    # Omit only this sampling preference after the provider identifies that problem.
    if "temperature" in payload and "temperature" in detail and any(
        phrase in detail for phrase in ("not supported", "unsupported", "only the default")
    ):
        return endpoint, {key: value for key, value in payload.items() if key != "temperature"}
    return None


def _has_strict_tools(payload: dict[str, object]) -> bool:
    return any(tool.get("function", tool).get("strict") is True for tool in payload.get("tools", []))


def _without_strict_tools(
    request: ChatCompletionRequest, endpoint: str, payload: dict[str, object], *, omit_field: bool = False,
) -> dict[str, object]:
    """Restore the ordinary schemas after a capability rejection; keep all tool permissions."""
    if not request.tools:
        return payload
    tools = []
    for tool in request.tools:
        definition = function_definition(tool.name, tool.description, tool.parameters, strict=False)
        if omit_field or endpoint.endswith("/chat/completions"):
            definition.pop("strict", None)
        tools.append({"type": "function", **definition} if endpoint.endswith("/responses")
                     else {"type": "function", "function": definition})
    return {**payload, "tools": tools}


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
    """Read the first completion choice and reject malformed tool-call envelopes."""
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
    """Accept common usage field names and repair missing or inconsistent totals."""
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
