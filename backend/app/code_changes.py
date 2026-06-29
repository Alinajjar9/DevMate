import json
import re
from dataclasses import dataclass


MAX_FILE_CHANGES = 10
MAX_FILE_CHANGE_CHARACTERS = 200_000
MAX_TOTAL_CHANGE_CHARACTERS = 500_000


@dataclass(frozen=True)
class CodeFileChange:
    path: str
    content: str


class CodeChangeParseError(ValueError):
    pass


def parse_code_change_response(value: str) -> tuple[str, list[CodeFileChange]]:
    serialized = _strip_optional_code_fence(value.strip())
    try:
        payload = json.loads(serialized)
    except json.JSONDecodeError as error:
        raise CodeChangeParseError(
            "The model did not return a valid file-change response. Try the request again."
        ) from error

    if not isinstance(payload, dict):
        raise CodeChangeParseError("The model file-change response must be an object.")
    summary = payload.get("summary")
    raw_changes = payload.get("changes")
    if not isinstance(summary, str) or not summary.strip():
        raise CodeChangeParseError("The model file-change response is missing a summary.")
    if not isinstance(raw_changes, list):
        raise CodeChangeParseError("The model file-change response is missing its changes list.")
    if len(raw_changes) > MAX_FILE_CHANGES:
        raise CodeChangeParseError(
            f"The model proposed more than {MAX_FILE_CHANGES} file changes."
        )

    changes: list[CodeFileChange] = []
    seen_paths: set[str] = set()
    total_characters = 0
    for raw_change in raw_changes:
        if not isinstance(raw_change, dict):
            raise CodeChangeParseError("A proposed file change is invalid.")
        path = raw_change.get("path")
        content = raw_change.get("content")
        if not isinstance(path, str) or not isinstance(content, str):
            raise CodeChangeParseError("A proposed file change is missing its path or content.")

        normalized_path = _normalize_relative_path(path)
        comparable_path = normalized_path.casefold()
        if comparable_path in seen_paths:
            raise CodeChangeParseError("The model proposed the same file more than once.")
        if len(content) > MAX_FILE_CHANGE_CHARACTERS:
            raise CodeChangeParseError(
                f"A proposed file exceeds {MAX_FILE_CHANGE_CHARACTERS} characters."
            )

        total_characters += len(content)
        if total_characters > MAX_TOTAL_CHANGE_CHARACTERS:
            raise CodeChangeParseError("The proposed file changes are too large to apply safely.")
        seen_paths.add(comparable_path)
        changes.append(CodeFileChange(path=normalized_path, content=content))

    return summary.strip(), changes


def _normalize_relative_path(value: str) -> str:
    path = value.strip()
    if (
        not path
        or "\x00" in path
        or path.startswith(("/", "\\"))
        or re.match(r"^[A-Za-z]:", path)
    ):
        raise CodeChangeParseError("A proposed file path is not workspace-relative.")

    normalized = path.replace("\\", "/")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise CodeChangeParseError("A proposed file path contains unsafe segments.")
    return "/".join(parts)


def _strip_optional_code_fence(value: str) -> str:
    if not value.startswith("```"):
        return value
    lines = value.splitlines()
    if len(lines) < 3 or lines[-1].strip() != "```":
        return value
    return "\n".join(lines[1:-1]).strip()
