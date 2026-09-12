"""Validate the opaque Responses state kept between calls in one agent run."""

import json


MAX_PROVIDER_STATE_CHARACTERS = 2_000_000
MAX_PROVIDER_STATE_HISTORY_CHARACTERS = 8_000_000
MAX_PROVIDER_OUTPUT_ITEMS = 16
MAX_PROVIDER_CONTENT_PARTS = 8


def _text_size(value: str) -> int:
    try:
        return len(value.encode("utf-16-le")) // 2
    except UnicodeError:
        raise ValueError("providerState contains invalid text") from None


def serialized_provider_state_size(value: dict[str, object]) -> int:
    """Use the same compact JSON and UTF-16 units as the extension's state limit."""
    return _text_size(json.dumps(value, separators=(",", ":"), ensure_ascii=False))


def _record(value: object, required: set[str], optional: set[str] | None = None) -> dict:
    if not isinstance(value, dict) or not required <= value.keys():
        raise ValueError("providerState has an invalid structure")
    if not value.keys() <= required | (optional or set()):
        raise ValueError("providerState contains unsupported fields")
    return value


def _string(value: object, limit: int, *, allow_empty: bool = False) -> None:
    if not isinstance(value, str):
        raise ValueError("providerState has an invalid text field")
    if _text_size(value) > limit or (not allow_empty and not value.strip()):
        raise ValueError("providerState has an empty or oversized text field")


def _empty_list(value: object) -> None:
    if not isinstance(value, list) or value:
        raise ValueError("providerState summaries and annotations must be empty")


def _validate_output_item(value: object) -> None:
    if not isinstance(value, dict):
        raise ValueError("providerState has an invalid output item")
    kind = value.get("type")
    if kind == "reasoning":
        item = _record(value, {"id", "type", "summary", "encrypted_content"})
        _string(item["id"], 200)
        _empty_list(item["summary"])
        _string(item["encrypted_content"], 1_000_000)
    elif kind == "function_call":
        item = _record(value, {"type", "name", "call_id", "arguments"}, {"id"})
        _string(item["name"], 120)
        _string(item["call_id"], 120)
        _string(item["arguments"], 1_200_000, allow_empty=True)
    elif kind == "message":
        item = _record(value, {"type", "role", "content"}, {"id", "phase"})
        if item["role"] != "assistant":
            raise ValueError("providerState messages must have the assistant role")
        if "phase" in item and item["phase"] not in ("commentary", "final_answer"):
            raise ValueError("providerState has an invalid message phase")
        content = item["content"]
        if not isinstance(content, list) or len(content) > MAX_PROVIDER_CONTENT_PARTS:
            raise ValueError("providerState has too many message content parts")
        for raw_part in content:
            part = _record(raw_part, {"type", "text", "annotations"})
            if part["type"] != "output_text":
                raise ValueError("providerState contains an unsupported content type")
            _string(part["text"], 400_000, allow_empty=True)
            _empty_list(part["annotations"])
    else:
        raise ValueError("providerState contains an unsupported output type")
    if "id" in item:
        _string(item["id"], 200)


def validate_provider_state(value: object) -> dict[str, object]:
    """Check a small allowed shape without editing it or exposing its contents in errors.

    Reasoning is retained only as encrypted content. The provider adapter checks
    the endpoint, model, and matching function call before sending this state back.
    """
    state = _record(value, {"endpoint", "model", "outputItems"})
    _string(state["endpoint"], 2_048)
    _string(state["model"], 120)
    items = state["outputItems"]
    if not isinstance(items, list) or len(items) > MAX_PROVIDER_OUTPUT_ITEMS:
        raise ValueError("providerState has too many output items")
    for item in items:
        _validate_output_item(item)
    if serialized_provider_state_size(state) > MAX_PROVIDER_STATE_CHARACTERS:
        raise ValueError("providerState is too large")
    return state
