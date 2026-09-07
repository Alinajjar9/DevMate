# Shared input rules for the lexical and embedding repositories.
# Both repositories still validate each call; sharing the rule prevents their policies drifting.

import re
from pathlib import PurePosixPath

from .knowledge_contracts import MAX_RELATIVE_PATH_CHARACTERS, MAX_SQLITE_INTEGER


class KnowledgeRepositoryError(RuntimeError):
    """Raised when a knowledge-index repository operation cannot complete."""


class KnowledgeRepositoryValidationError(KnowledgeRepositoryError):
    """Raised when repository input violates the local index contract."""


class KnowledgeRepositoryNotFoundError(KnowledgeRepositoryError):
    """Raised when an operation targets an unknown workspace."""


def bounded_text(value: object, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 for character in value)
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value


def validate_relative_path(value: object) -> str:
    relative_path = bounded_text(value, "relative path", MAX_RELATIVE_PATH_CHARACTERS)
    normalized = relative_path.replace("\\", "/")
    parsed = PurePosixPath(normalized)
    if (
        parsed.is_absolute()
        or normalized.startswith("//")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in ("", ".", "..") for part in parsed.parts)
    ):
        raise KnowledgeRepositoryValidationError("The relative path is invalid.")
    return parsed.as_posix()


def positive_integer(value: object, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= MAX_SQLITE_INTEGER
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value


def nonnegative_integer(value: object, label: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 0 <= value <= MAX_SQLITE_INTEGER
    ):
        raise KnowledgeRepositoryValidationError(f"The {label} is invalid.")
    return value
