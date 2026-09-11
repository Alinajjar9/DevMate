"""Model-facing tool names, capability groups and parameter schemas."""

from typing import Literal

from .providers import ChatToolDefinition


AgentToolName = Literal[
    "list_files",
    "read_file",
    "search_code",
    "get_symbols",
    "find_definition",
    "find_references",
    "get_diagnostics",
    "read_terminal_errors",
    "create_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "move_file",
    "install_dependencies",
    "run_command",
]
# Ideas mode exposes only this group; editing, installation, and commands belong to the next group.
READ_ONLY_AGENT_TOOLS: tuple[AgentToolName, ...] = (
    "list_files",
    "read_file",
    "search_code",
    "get_symbols",
    "find_definition",
    "find_references",
    "get_diagnostics",
    "read_terminal_errors",
)
MUTATING_AGENT_TOOLS: tuple[AgentToolName, ...] = (
    "create_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "move_file",
    "install_dependencies",
    "run_command",
)


# These schemas guide the model. The extension still validates arguments and permissions before execution.
AGENT_TOOL_DEFINITIONS = (
    ChatToolDefinition(
        name="list_files",
        description="List eligible workspace text files, optionally below a relative directory.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional path relative to the open workspace. Do not include the workspace folder name. Use an empty string for the project root.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 500,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="read_file",
        description="Read one eligible text file using its workspace-relative path.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path relative to the open workspace; never an absolute path.",
                },
                "startLine": {"type": "integer", "minimum": 1},
                "endLine": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="search_code",
        description="Search eligible project text files for a plain-text query and return matching lines.",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 2, "maxLength": 200},
                "path": {
                    "type": "string",
                    "description": "Optional file or directory relative to the open workspace. Do not include the workspace folder name.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200,
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="get_symbols",
        description=(
            "Read the structural symbols declared in one workspace file through VS Code's language provider. "
            "Returns symbol kinds, names, containers, and one-based source positions."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="find_definition",
        description=(
            "Find workspace definitions for the symbol at a one-based line and column using VS Code's language provider. "
            "Use read_file or search_code first to identify the source position."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "line": {"type": "integer", "minimum": 1},
                "column": {"type": "integer", "minimum": 1},
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path", "line", "column"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="find_references",
        description=(
            "Find workspace references for the symbol at a one-based line and column using VS Code's language provider. "
            "Use read_file or search_code first to identify the source position."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative source file path; never an absolute path.",
                },
                "line": {"type": "integer", "minimum": 1},
                "column": {"type": "integer", "minimum": 1},
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "required": ["path", "line", "column"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="get_diagnostics",
        description=(
            "Read current VS Code Problems diagnostics for workspace files. "
            "Returns errors and warnings with workspace-relative paths and positions."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative file or directory. Use an empty string for the entire workspace.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 300,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="read_terminal_errors",
        description=(
            "Read recent failed commands captured from user terminals in the current workspace. "
            "Only failures observed after DevMate activation through VS Code Terminal Shell Integration are available."
        ),
        parameters={
            "type": "object",
            "properties": {
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                },
            },
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="create_file",
        description=(
            "Create one new eligible workspace text file, automatically creating missing parent directories. "
            "Use complete file content and never use this for an existing file or create placeholder .gitkeep files."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "New file path relative to the open workspace; never an absolute path.",
                },
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="edit_file",
        description=(
            "Edit an existing text file with 1-20 sequential exact replacements. Each oldText must match exactly once."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace; never an absolute path.",
                },
                "replacements": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": {"type": "string", "minLength": 1},
                            "newText": {"type": "string"},
                        },
                        "required": ["oldText", "newText"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["path", "replacements"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="delete_file",
        description=(
            "Delete one existing eligible workspace text file. Use only when removal is necessary. "
            "The extension always asks the user for one-time approval and does not delete directories."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace; never an absolute path.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="rename_file",
        description=(
            "Rename one existing eligible workspace text file within its current directory. "
            "The destination must not exist and the extension always asks for one-time approval."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace.",
                },
                "newPath": {
                    "type": "string",
                    "description": "New file path in the same directory, relative to the open workspace.",
                },
            },
            "required": ["path", "newPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="move_file",
        description=(
            "Move one existing eligible workspace text file to a different workspace-relative path. "
            "Missing destination directories are created automatically. The destination must not exist and the "
            "extension always asks for one-time approval. Never use run_command with move, mv, or mkdir."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Existing file path relative to the open workspace.",
                },
                "newPath": {
                    "type": "string",
                    "description": "Destination file path relative to the open workspace.",
                },
            },
            "required": ["path", "newPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="install_dependencies",
        description=(
            "Install Python dependencies from one validated requirements*.txt manifest into a project-local virtual "
            "environment. Use only after verification reports a missing dependency. This always requires explicit "
            "user approval; never use run_command for pip or package installation."
        ),
        parameters={
            "type": "object",
            "properties": {
                "manifestPath": {
                    "type": "string",
                    "description": "Path to requirements.txt or requirements-*.txt relative to the open workspace.",
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 1800,
                },
            },
            "required": ["manifestPath"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="run_command",
        description=(
            "Run one approved verification command such as a test, lint, type-check, or build command. "
            "Installation, Git, shells, servers, generators, and writable formatters are blocked. "
            "If pytest is unavailable, convert the tests to Python unittest and run "
            "python -m unittest <test-file> -v instead of trying to install pytest."
        ),
        parameters={
            "type": "object",
            "properties": {
                "executable": {"type": "string"},
                "args": {
                    "type": "array",
                    "maxItems": 50,
                    "items": {"type": "string", "maxLength": 500},
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory relative to the open workspace. Use '.' for the workspace root and do not include the workspace folder name.",
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 1800,
                },
            },
            "required": ["executable"],
            "additionalProperties": False,
        },
    ),
)
