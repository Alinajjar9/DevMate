"""Translate Responses API items and events into DevMate's existing tool conversation.

Responses keeps reasoning context in opaque encrypted items. Carry those items
with the completed tool call so the next turn (or a resumed task) can replay them
without putting private model context in the chat or storing responses remotely.
"""

import json
from collections.abc import AsyncIterator
from dataclasses import replace

import httpx

from .provider_state import validate_provider_state
from .tool_schemas import function_definition
from .providers import (
    ChatCompletion, ChatCompletionRequest, ChatStreamEvent, ChatToolCall,
    ProviderError, _bounded_detail, _iter_stream_chunks, _read_token_usage,
)


def build_responses_payload(
    request: ChatCompletionRequest, endpoint: str, *, stream: bool, strict_tools: bool = True,
) -> dict[str, object]:
    """Keep Auto as the provider default and serialize tools in Responses format."""
    items: list[dict[str, object]] = []
    for message in request.messages:
        state = message.provider_state
        if state and state.get("endpoint") == endpoint and state.get("model") == request.model:
            try:
                state = validate_provider_state(state)
            except ValueError as error:
                raise ProviderError("The saved model context is invalid. Start a new request.", 400) from error
            calls = [item for item in state["outputItems"] if item["type"] == "function_call"]
            if [(item["call_id"], item["name"]) for item in calls] != [
                (call.id, call.name) for call in message.tool_calls
            ]:
                raise ProviderError("The saved model context does not match its tool result.", 400)
            # Replay original arguments and assistant phase, even if the visible history was compacted.
            items.extend(state["outputItems"])
            continue
        if message.role == "tool":
            items.append({"type": "function_call_output", "call_id": message.tool_call_id,
                          "output": message.content or ""})
            continue
        if message.content:
            items.append({"role": message.role, "content": message.content})
        for call in message.tool_calls:
            items.append({"type": "function_call", "call_id": call.id,
                          "name": call.name, "arguments": call.arguments})

    payload: dict[str, object] = {
        "model": request.model, "input": items, "stream": stream,
        "max_output_tokens": request.max_tokens, "temperature": request.temperature,
        "store": False, "include": ["reasoning.encrypted_content"],
    }
    if request.reasoning_effort != "auto":
        payload["reasoning"] = {"effort": request.reasoning_effort}
    if request.tools:
        payload["tools"] = [{"type": "function", **function_definition(
            tool.name, tool.description, tool.parameters, strict=strict_tools,
        )} for tool in request.tools]
        payload["tool_choice"] = "auto"
        # One completed call owns its full response context and one checkpoint.
        payload["parallel_tool_calls"] = False
    return payload


def read_responses_completion(
    payload: object, request: ChatCompletionRequest, endpoint: str,
) -> ChatCompletion:
    """Validate a terminal response before making any returned tool executable."""
    if not isinstance(payload, dict):
        raise ProviderError("The Responses endpoint returned an invalid answer.", 502)
    status = payload.get("status")
    if status in {"failed", "cancelled"} or payload.get("error"):
        raise _response_error(payload)
    if status not in {"completed", "incomplete"}:
        raise ProviderError("The Responses endpoint did not complete the answer.", 502)
    output = payload.get("output")
    if not isinstance(output, list) or len(output) > 16:
        raise ProviderError("The Responses endpoint returned invalid output items.", 502)

    text: list[str] = []
    calls: list[ChatToolCall] = []
    replay: list[dict[str, object]] = []
    for item in output:
        if not isinstance(item, dict):
            raise ProviderError("The Responses endpoint returned an invalid output item.", 502)
        item_type = item.get("type")
        if item_type == "reasoning":
            encrypted = item.get("encrypted_content")
            if encrypted:
                replay.append({"type": "reasoning", "id": item.get("id"),
                               "summary": [], "encrypted_content": encrypted})
            elif status == "completed" and any(
                isinstance(value, dict) and value.get("type") == "function_call" for value in output
            ):
                raise ProviderError("The Responses endpoint did not return reusable reasoning context for its tool call.", 502)
        elif item_type == "message":
            parts = item.get("content")
            if not isinstance(parts, list) or len(parts) > 8 or item.get("role") != "assistant":
                raise ProviderError("The Responses endpoint returned an invalid assistant message.", 502)
            content: list[dict[str, object]] = []
            for part in parts:
                if not isinstance(part, dict):
                    raise ProviderError("The Responses endpoint returned invalid message content.", 502)
                value = part.get("text") if part.get("type") == "output_text" else part.get("refusal")
                if not isinstance(value, str) or len(value) > 400_000:
                    raise ProviderError("The Responses endpoint returned invalid message text.", 502)
                text.append(value)
                content.append({"type": "output_text", "text": value, "annotations": []})
            saved_message: dict[str, object] = {"type": "message", "role": "assistant", "content": content}
            if item.get("id"):
                saved_message["id"] = item["id"]
            if item.get("phase") is not None:
                saved_message["phase"] = item["phase"]
            replay.append(saved_message)
        elif item_type == "function_call":
            if status != "completed" or item.get("status", "completed") != "completed":
                raise ProviderError("The model stopped before completing its tool call. No tool was run.", 502)
            call = {"type": "function_call", "call_id": item.get("call_id"),
                    "name": item.get("name"), "arguments": item.get("arguments")}
            if item.get("id"):
                call["id"] = item["id"]
            replay.append(call)
            calls.append(ChatToolCall(id=call["call_id"], name=call["name"], arguments=call["arguments"]))
        else:
            raise ProviderError("The Responses endpoint returned an unsupported output item.", 502)

    if len(calls) > 1:
        raise ProviderError("The Responses endpoint ignored the single-tool request. No tools were run.", 502)
    if calls:
        try:
            state = validate_provider_state({"endpoint": endpoint, "model": request.model, "outputItems": replay})
        except ValueError as error:
            raise ProviderError("The model returned invalid or oversized tool context. No tool was run.", 502) from error
        calls[0] = replace(calls[0], provider_state=state)
    content = "".join(text).strip() or None
    if not content and not calls and status == "completed":
        raise ProviderError("The model provider returned an empty or invalid answer.", 502)
    return ChatCompletion(
        content=content, tool_calls=tuple(calls),
        finish_reason="length" if status == "incomplete" else "tool_calls" if calls else "stop",
        usage=_read_token_usage(payload),
    )


async def read_responses_events(
    response: httpx.Response, request: ChatCompletionRequest, endpoint: str,
) -> AsyncIterator[ChatStreamEvent]:
    """Stream text/progress, but accept tools only from a complete terminal response."""
    if "text/event-stream" not in response.headers.get("content-type", "").casefold():
        try:
            payload = json.loads(await response.aread())
        except ValueError as error:
            raise ProviderError("The Responses endpoint returned a non-JSON response.", 502) from error
        completion = read_responses_completion(payload, request, endpoint)
        if completion.content:
            yield ChatStreamEvent(kind="content", text=completion.content)
        yield ChatStreamEvent(kind="complete", completion=completion)
        return

    async for event in _iter_stream_chunks(response):
        if not isinstance(event, dict):
            raise ProviderError("The Responses endpoint returned an invalid streaming event.", 502)
        event_type = event.get("type")
        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
            delta = event.get("delta")
            if not isinstance(delta, str):
                raise ProviderError("The Responses endpoint returned invalid streamed text.", 502)
            yield ChatStreamEvent(kind="content", text=delta)
        elif event_type == "response.output_item.added":
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") in {"reasoning", "function_call"}:
                yield ChatStreamEvent(kind="reasoning" if item["type"] == "reasoning" else "tool")
        elif event_type in {"response.completed", "response.incomplete"}:
            completion = read_responses_completion(event.get("response"), request, endpoint)
            yield ChatStreamEvent(kind="complete", completion=completion)
            return
        elif event_type in {"error", "response.failed"}:
            raise _response_error(event.get("response", event))
        # Argument fragments and private reasoning are never shown or executed.
    raise ProviderError("The Responses stream ended before the answer completed. No tool was run.", 502)


def _response_error(payload: object) -> ProviderError:
    detail = None
    if isinstance(payload, dict):
        error = payload.get("error", payload)
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            detail = _bounded_detail(error["message"])
    return ProviderError(detail or "The Responses endpoint could not finish the request.", 502)
