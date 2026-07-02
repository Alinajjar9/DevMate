import json
import re
import uuid
from typing import Literal

from .providers import ChatToolCall


MAX_TEXT_TOOL_CALL_CHARACTERS = 1_200_000
MAX_TEXT_TOOL_CALLS = 3
MAX_TEXT_TOOL_PARAMETERS = 32
_TOOL_CALL_OPEN = "<tool_call>"
_NAME_PATTERN = r"[A-Za-z_][A-Za-z0-9_]{0,119}"
_TOOL_CALL_PATTERN = re.compile(
    rf"\s*<tool_call>\s*<function=({_NAME_PATTERN})>(.*?)</function>\s*</tool_call>",
    re.DOTALL,
)
_PARAMETER_PATTERN = re.compile(
    rf"\s*<parameter=({_NAME_PATTERN})>(.*?)</parameter>",
    re.DOTALL,
)


def classify_text_tool_call_prefix(text: str) -> Literal["pending", "answer", "tool"]:
    """Classify initial streamed text without exposing a possible tool block."""
    stripped = text.lstrip()
    if not stripped:
        return "pending" if len(text) <= 256 else "answer"
    if stripped.startswith(_TOOL_CALL_OPEN):
        return "tool"
    if _TOOL_CALL_OPEN.startswith(stripped):
        return "pending"
    return "answer"


def looks_like_text_tool_call(text: str) -> bool:
    return text.lstrip().startswith(_TOOL_CALL_OPEN)


def parse_text_tool_calls(text: str) -> tuple[ChatToolCall, ...] | None:
    """Parse Nemotron-style textual calls only when they occupy the full response."""
    if not text or len(text) > MAX_TEXT_TOOL_CALL_CHARACTERS:
        return None

    calls: list[ChatToolCall] = []
    position = 0
    while position < len(text):
        match = _TOOL_CALL_PATTERN.match(text, position)
        if match is None:
            return None
        if len(calls) >= MAX_TEXT_TOOL_CALLS:
            return None

        name = match.group(1)
        parameter_text = match.group(2)
        arguments: dict[str, object] = {}
        parameter_position = 0
        while parameter_position < len(parameter_text):
            if not parameter_text[parameter_position:].strip():
                parameter_position = len(parameter_text)
                break
            parameter_match = _PARAMETER_PATTERN.match(parameter_text, parameter_position)
            if parameter_match is None:
                return None
            parameter_name = parameter_match.group(1)
            if parameter_name in arguments or len(arguments) >= MAX_TEXT_TOOL_PARAMETERS:
                return None
            arguments[parameter_name] = _decode_parameter(
                parameter_name,
                parameter_match.group(2),
            )
            parameter_position = parameter_match.end()

        calls.append(
            ChatToolCall(
                id=f"compat-{uuid.uuid4().hex}",
                name=name,
                arguments=json.dumps(arguments, separators=(",", ":"), ensure_ascii=False),
            )
        )
        position = match.end()
        if not text[position:].strip():
            position = len(text)

    return tuple(calls) if calls else None


def _decode_parameter(name: str, raw_value: str) -> object:
    value = raw_value
    if value.startswith("\r\n"):
        value = value[2:]
    elif value.startswith("\n"):
        value = value[1:]
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]

    candidate = value.strip()
    if not candidate:
        return ""
    try:
        return json.loads(candidate)
    except (TypeError, json.JSONDecodeError):
        return value if name == "content" else candidate
