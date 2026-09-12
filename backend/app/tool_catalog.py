"""Model-facing tool names, capability groups and parameter schemas."""

from typing import Literal

from .providers import ChatToolDefinition


AgentToolName = Literal[
    "list_files",
    "get_project_info",
    "get_git_changes",
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
    "rename_symbol",
    "format_file",
    "install_dependencies",
    "run_command",
    "stop_command",
]
# Ideas mode exposes only this group; editing, installation, and commands belong to the next group.
READ_ONLY_AGENT_TOOLS: tuple[AgentToolName, ...] = (
    "list_files",
    "get_project_info",
    "get_git_changes",
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
    "rename_symbol",
    "format_file",
    "install_dependencies",
    "run_command",
    "stop_command",
)


# These schemas guide the model. The extension still validates arguments and permissions before execution.
AGENT_TOOL_DEFINITIONS = (
    ChatToolDefinition(
        name="get_project_info",
        description=(
            "Summarize eligible project manifests, detected frameworks, package managers, available scripts, "
            "verification commands and nested projects without running project code. Use this to discover how a project is built or tested."
        ),
        parameters={
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Optional workspace-relative directory; empty means the project root."}},
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="get_git_changes",
        description=(
            "Read the current Git branch, eligible changed paths and bounded diffs. "
            "Use staged=true for staged diffs; the default shows unstaged diffs. Protected file contents and untracked contents are omitted."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Optional file or directory relative to the workspace; empty means the project root."},
                "staged": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    ),
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
        description=(
            "Read complete lines from one eligible text file using its workspace-relative path. "
            "The result states the actual returned range and the next line when more remains. "
            "For edit_file, copy text from Content only, not the header or continuation note."
        ),
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
        description="Search eligible project text files for a literal query, with optional case/whole-word matching, a file glob and nearby lines. The query is never a regular expression.",
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
                "caseSensitive": {"type": "boolean"},
                "wholeWord": {"type": "boolean"},
                "filePattern": {"type": "string", "maxLength": 200, "description": "Optional relative glob, such as **/*.ts or **/*.{ts,tsx}. A plain *.ts pattern matches in every directory."},
                "contextLines": {"type": "integer", "minimum": 0, "maximum": 5},
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
            "Edit an existing text file with 1-20 sequential exact replacements in a replacements array. "
            "Each oldText must be non-empty and match exactly once; newText must be a string. "
            "Use newText=\"\" to delete the matched text. An empty replacements array does nothing and is invalid. "
            "All replacements are checked before saving; a failed replacement leaves the file unchanged. "
            "Examples: replace {\"oldText\":\"colour\",\"newText\":\"color\"}; "
            "delete {\"oldText\":\"obsolete text\",\"newText\":\"\"}; "
            "insert after an anchor {\"oldText\":\"</head>\",\"newText\":\"<link rel=\\\"stylesheet\\\" href=\\\"styles.css\\\">\\n</head>\"}. "
            "Put these objects inside replacements and use exact current file text for the anchors."
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
                            "oldText": {"type": "string", "minLength": 1,
                                        "description": "Exact existing text, including whitespace; must match once. Never empty."},
                            "newText": {"type": "string",
                                        "description": "Literal replacement text. Empty string deletes oldText; null or omission is invalid."},
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
        name="rename_symbol",
        description=(
            "Rename a code symbol and its references using the installed VS Code language service. "
            "Specify a one-based source position and the new symbol name. The extension reviews eligible text edits and applies them together after permission."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative source file containing the symbol."},
                "line": {"type": "integer", "minimum": 1, "maximum": 10_000_000},
                "column": {"type": "integer", "minimum": 1, "maximum": 10_000_000},
                "newName": {"type": "string", "minLength": 1, "maxLength": 200},
            },
            "required": ["path", "line", "column", "newName"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="format_file",
        description=(
            "Format one eligible file using its installed VS Code formatter and project formatting settings. "
            "Requires an available formatter and permission to apply the resulting text edits."
        ),
        parameters={
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Workspace-relative text file path."}},
            "required": ["path"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="run_command",
        description=(
            "Run one command allowed by the workspace's command-access setting after approval. "
            "Standard access is limited to verification commands; Extended access permits additional project commands. "
            "Use background=true only for a long-running process such as a development server, when Extended access permits it; "
            "retain its returned id and stop it with stop_command when finished."
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
                "background": {"type": "boolean"},
            },
            "required": ["executable"],
            "additionalProperties": False,
        },
    ),
    ChatToolDefinition(
        name="stop_command",
        description="Stop a background command started by DevMate using the id returned by run_command. This cannot stop unrelated user terminals or processes.",
        parameters={
            "type": "object",
            "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 200}},
            "required": ["id"],
            "additionalProperties": False,
        },
    ),
)
