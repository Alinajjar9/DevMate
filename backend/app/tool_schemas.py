"""Adapt the shared tool definitions without changing the executor's argument contract."""

from copy import deepcopy


def strict_tool_schema(schema: dict[str, object]) -> dict[str, object]:
    """Make optional fields nullable and every object closed, as strict tools require.

    Required strings stay strings: in particular, newText may be empty but may
    never be null. Copies keep the ordinary provider schema unchanged.
    """
    result = deepcopy(schema)
    if result.get("type") == "object":
        properties = result.get("properties", {})
        required = set(result.get("required", []))
        normalized = {}
        for name, child in properties.items():
            adapted = strict_tool_schema(child)
            if name not in required:
                adapted = {"anyOf": [adapted, {"type": "null"}]}
            normalized[name] = adapted
        result.update(properties=normalized, required=list(normalized), additionalProperties=False)
    if isinstance(result.get("items"), dict):
        result["items"] = strict_tool_schema(result["items"])
    return result


def function_definition(name: str, description: str, parameters: dict[str, object], *, strict: bool) -> dict[str, object]:
    return {"name": name, "description": description,
            "parameters": strict_tool_schema(parameters) if strict else parameters,
            "strict": strict}


def omit_optional_nulls(arguments: dict[str, object], schema: dict[str, object]) -> dict[str, object]:
    """Treat null on declared optional fields as omitted; preserve invalid required values.

    Strict providers must return optional fields explicitly. The executor uses
    absent fields for defaults. Required nulls are left for its precise errors.
    """
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    result = {}
    for name, value in arguments.items():
        child = properties.get(name)
        if value is None and child is not None and name not in required:
            continue
        if isinstance(child, dict):
            if child.get("type") == "object" and isinstance(value, dict):
                value = omit_optional_nulls(value, child)
            elif child.get("type") == "array" and isinstance(value, list):
                item_schema = child.get("items", {})
                if item_schema.get("type") == "object":
                    value = [omit_optional_nulls(item, item_schema) if isinstance(item, dict) else item for item in value]
        result[name] = value
    return result
