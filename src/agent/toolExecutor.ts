// Validate and dispatch tool calls to VS Code workspace services.
// Return bounded results to the agent; permission and mutation checks stay in their owners.

import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MAX_DEPENDENCY_MANIFEST_BYTES,
  boundedAgentToolHistoryArguments,
  parseAgentToolCall,
  summarizedAgentToolArguments,
  truncateAgentToolResult,
  validatePythonRequirementsManifest
} from './agentTools';
import type {
  AgentToolSettings,
  ParsedAgentToolCall
} from './agentTools';
import type { AgentToolCall } from './agentToolProtocol';
import type { AgentToolStep } from '../api/types';
import {
  extractMissingPythonModule,
  isPythonVerificationCommand,
  workspacePythonCandidates,
  workspacePythonExecutable
} from '../api/backendManager';
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_CAPTURED_TERMINAL_ERRORS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS,
  boundedModelCommandOutput,
  commandLabel,
  commandSignature,
  formatCapturedTerminalErrors,
  sanitizeCapturedTerminalText,
  sanitizeCommandOutput
} from '../workspace/commandTools';
import type { CapturedTerminalError, ValidatedCommand } from '../workspace/commandTools';
import {
  applyExactReplacements,
  validateFileChanges
} from '../workspace/fileTools';
import {
  MAX_ATTACHMENT_CANDIDATES,
  MAX_PROJECT_CANDIDATES,
  PROJECT_EXCLUDE_GLOB,
  containsBinaryData,
  shouldSkipProjectFile
} from '../projectSearch/projectIndex';
import {
  WorkspaceContext,
  normalizeRelativeWorkspacePath
} from '../context/workspaceContext';
import { WorkspaceMutations } from '../workspace/workspaceMutations';

type WorkspaceCodeLocation = {
  path: string;
  line: number;
  column: number;
  filePath: string;
};

export type AgentToolExecution = {
  step: AgentToolStep;
  usedFiles: string[];
  mutationCharacters: number;
  mutationApplied?: boolean;
  commandAttempted?: boolean;
  missingDependency?: string;
  pythonEnvironment?: string;
  installAttempted?: boolean;
  environmentChanged?: boolean;
};

type ActiveTerminalCapture = {
  command: string;
  cwd: string;
  terminalName: string;
  output: string;
  reader?: Promise<void>;
};

export class StartedCommandError extends Error {
  readonly commandAttempted = true;

  constructor(
    message: string,
    readonly missingDependency?: string,
    readonly pythonEnvironment?: string
  ) {
    super(message);
  }
}

export class StartedDependencyInstallError extends Error {
  readonly installAttempted = true;
}

export type ToolExecutionContext = {
  remainingMutationCharacters: number;
  signal: AbortSignal;
};

type CommandPermissionOptions = {
  rememberable?: boolean;
  title?: string;
  warning?: string;
};

export type ToolExecutorCallbacks = {
  getAgentToolSettings(): AgentToolSettings;
  requestCommandPermission(
    signature: string,
    label: string,
    cwd: string,
    options?: CommandPermissionOptions
  ): Promise<boolean>;
  postAgentToolActivity(
    id: string,
    title: string,
    detail: string,
    status: 'running' | 'completed' | 'error',
    result?: string,
    canOpenTerminal?: boolean
  ): void;
};

export class ToolExecutor {
  private readonly commandTerminals = new Map<string, vscode.Terminal>();
  private readonly activeTerminalCaptures =
    new Map<vscode.TerminalShellExecution, ActiveTerminalCapture>();
  private readonly recentTerminalErrors: CapturedTerminalError[] = [];

  constructor(
    private readonly workspaceContext: WorkspaceContext,
    private readonly workspaceMutations: WorkspaceMutations,
    private readonly callbacks: ToolExecutorCallbacks
  ) {}

  showCommandTerminal(activityId: string): void {
    this.commandTerminals.get(activityId)?.show(false);
  }

  clearActiveTerminalCaptures(): void {
    this.activeTerminalCaptures.clear();
  }

  async execute(
    call: AgentToolCall,
    context: ToolExecutionContext
  ): Promise<AgentToolExecution> {
    const { remainingMutationCharacters, signal } = context;
    let parsedCall: ParsedAgentToolCall;
    try {
      // Treat model arguments as untrusted data; nothing is dispatched until the call is validated.
      parsedCall = parseAgentToolCall(call);
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool request was invalid.';
      this.callbacks.postAgentToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
      return {
        step: {
          callId: call.id,
          name: call.name,
          arguments: boundedAgentToolHistoryArguments(call.name, call.arguments),
          result: truncateAgentToolResult(result),
          isError: true
        },
        usedFiles: [],
        mutationCharacters: 0
      };
    }

    const activity = describeAgentToolCall(parsedCall);
    this.callbacks.postAgentToolActivity(call.id, activity.title, activity.detail, 'running');

    try {
      const execution = await this.runAgentTool(parsedCall, remainingMutationCharacters, signal);
      this.callbacks.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'completed',
        execution.resultSummary,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
          && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
          arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(execution.result),
          isError: false
        },
        usedFiles: execution.usedFiles,
        mutationCharacters: execution.mutationCharacters,
        mutationApplied: execution.mutationApplied,
        commandAttempted: execution.commandAttempted,
        missingDependency: execution.missingDependency,
        pythonEnvironment: execution.pythonEnvironment,
        installAttempted: execution.installAttempted,
        environmentChanged: execution.environmentChanged
      };
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool could not be completed.';
      this.callbacks.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'error',
        result,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
          && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
          arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(result),
          isError: true
        },
        usedFiles: [],
        mutationCharacters: 0,
        // A failed command still spends a slot if it started. Validation/permission failures do not.
        commandAttempted: error instanceof StartedCommandError,
        missingDependency: error instanceof StartedCommandError
          ? error.missingDependency
          : undefined,
        pythonEnvironment: error instanceof StartedCommandError
          ? error.pythonEnvironment
          : undefined,
        installAttempted: error instanceof StartedDependencyInstallError
      };
    }
  }

  // Dispatch stays in one place so each supported tool's implementation is easy to find.
  private async runAgentTool(
    call: ParsedAgentToolCall,
    remainingMutationCharacters: number,
    signal: AbortSignal
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied?: boolean;
    commandAttempted?: boolean;
    missingDependency?: string;
    pythonEnvironment?: string;
    installAttempted?: boolean;
    environmentChanged?: boolean;
  }> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before using project tools.');
    }
    const toolSettings = this.callbacks.getAgentToolSettings();

    if (call.name === 'create_file') {
      await this.workspaceMutations.assertNoWorkspaceSymlink(folder, call.arguments.path, true);
      const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
      try {
        await vscode.workspace.fs.stat(uri);
        throw new Error(`${call.arguments.path} already exists; use edit_file instead.`);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
      const changes = validateFileChanges([call.arguments]);
      if (call.arguments.content.length > remainingMutationCharacters) {
        throw new Error('This request reached the total file-mutation size limit.');
      }
      const outcome = await this.workspaceMutations.confirmAndApplyFileChanges(
        changes,
        `Create ${call.arguments.path}`,
        signal
      );
      if (!outcome.startsWith('Applied file changes:')) {
        throw new Error('Permission to create the file was denied.');
      }
      return {
        result: outcome,
        resultSummary: `Created ${call.arguments.path}`,
        usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
        mutationCharacters: call.arguments.content.length,
        mutationApplied: true
      };
    }

    if (call.name === 'edit_file') {
      await this.workspaceMutations.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
      const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        throw new Error(`${call.arguments.path} does not exist or cannot be opened.`);
      }
      if (document.isDirty) {
        throw new Error(`Save or discard your unsaved changes in ${call.arguments.path} before DevMate edits it.`);
      }
      const updatedContent = applyExactReplacements(
        document.getText(),
        call.arguments.replacements
      );
      if (updatedContent.length > remainingMutationCharacters) {
        throw new Error('This request reached the total file-mutation size limit.');
      }
      const changes = validateFileChanges([{
        path: call.arguments.path,
        content: updatedContent
      }]);
      const outcome = await this.workspaceMutations.confirmAndApplyFileChanges(
        changes,
        `Edit ${call.arguments.path}`,
        signal
      );
      if (!outcome.startsWith('Applied file changes:')) {
        throw new Error('Permission to edit the file was denied.');
      }
      return {
        result: outcome,
        resultSummary: `Updated ${call.arguments.path}`,
        usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
        mutationCharacters: updatedContent.length,
        mutationApplied: true
      };
    }

    if (call.name === 'delete_file') {
      return this.deleteAgentFile(call, folder, remainingMutationCharacters, signal);
    }

    if (call.name === 'rename_file' || call.name === 'move_file') {
      return this.relocateAgentFile(call, folder, signal);
    }

    if (call.name === 'list_files') {
      const uris = await this.findAgentFiles(folder, call.arguments.path);
      const relativePaths = uris
        .map((uri) => normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false)))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, Math.min(call.arguments.maxResults, toolSettings.listFilesMaxResults));
      const result = relativePaths.length > 0
        ? `Eligible files (${relativePaths.length}):\n${relativePaths.join('\n')}`
        : 'No eligible files were found at that path.';
      return {
        result,
        resultSummary: `${relativePaths.length} eligible ${relativePaths.length === 1 ? 'file' : 'files'}`,
        usedFiles: [],
        mutationCharacters: 0
      };
    }

    if (call.name === 'read_file') {
      const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
      const candidate = await this.workspaceContext.readProjectCandidate(uri);
      if (
        !candidate
        || !agentPathMatches(
          normalizeRelativeWorkspacePath(candidate.relativePath),
          call.arguments.path
        )
      ) {
        throw new Error('The file does not exist or is excluded from DevMate context.');
      }
      const lines = candidate.content.split(/\r?\n/);
      const startLine = call.arguments.startLine ?? 1;
      const requestedEndLine = call.arguments.endLine
        ?? startLine + toolSettings.readFileMaxLines - 1;
      if (requestedEndLine - startLine + 1 > toolSettings.readFileMaxLines) {
        throw new Error(
          `read_file is configured to return at most ${toolSettings.readFileMaxLines} lines per call.`
        );
      }
      const endLine = Math.min(requestedEndLine, lines.length);
      if (startLine > lines.length && lines.length > 0) {
        throw new Error(`${call.arguments.path} has only ${lines.length} lines.`);
      }
      const selectedContent = lines.slice(startLine - 1, endLine).join('\n');
      const result = truncateAgentToolResult([
        `Path: ${call.arguments.path}`,
        `Language: ${candidate.languageId}`,
        `Lines: ${startLine}-${Math.max(startLine, endLine)} of ${lines.length}`,
        'Content:',
        selectedContent
      ].join('\n'));
      return {
        result,
        resultSummary: `${selectedContent.length} characters read`,
        usedFiles: [candidate.filePath],
        mutationCharacters: 0
      };
    }

    if (call.name === 'get_diagnostics') {
      return this.readWorkspaceDiagnostics(call, folder);
    }

    if (call.name === 'get_symbols') {
      return this.readDocumentSymbols(call, folder);
    }

    if (call.name === 'find_definition' || call.name === 'find_references') {
      return this.findCodeLocations(call, folder);
    }

    if (call.name === 'read_terminal_errors') {
      const maxResults = Math.min(
        call.arguments.maxResults,
        toolSettings.terminalErrorsMaxResults
      );
      const available = Math.min(maxResults, this.recentTerminalErrors.length);
      return {
        result: formatCapturedTerminalErrors(
          this.recentTerminalErrors,
          maxResults
        ),
        resultSummary: `${available} recent terminal ${available === 1 ? 'failure' : 'failures'}`,
        usedFiles: [],
        mutationCharacters: 0
      };
    }

    if (call.name === 'install_dependencies') {
      return this.runDependencyInstallation(call, folder, signal);
    }

    if (call.name === 'run_command') {
      return this.runVerificationCommand(call, folder, signal);
    }

    const uris = await this.findAgentFiles(folder, call.arguments.path);
    const query = call.arguments.query.toLocaleLowerCase();
    const matches: string[] = [];
    const usedFiles = new Set<string>();
    const maxSearchResults = Math.min(
      call.arguments.maxResults,
      toolSettings.searchCodeMaxResults
    );
    const batchSize = 20;
    for (let offset = 0; offset < uris.length && matches.length < maxSearchResults; offset += batchSize) {
      const candidates = await Promise.all(
        uris.slice(offset, offset + batchSize).map((uri) => this.workspaceContext.readProjectCandidate(uri))
      );
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        const relativePath = normalizeRelativeWorkspacePath(candidate.relativePath);
        const lines = candidate.content.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (!lines[lineIndex].toLocaleLowerCase().includes(query)) {
            continue;
          }
          const snippet = lines[lineIndex].trim().slice(0, 240);
          matches.push(`${relativePath}:${lineIndex + 1}: ${snippet}`);
          usedFiles.add(candidate.filePath);
          if (matches.length >= maxSearchResults) {
            break;
          }
        }
        if (matches.length >= maxSearchResults) {
          break;
        }
      }
    }

    const result = matches.length > 0
      ? `Matches for "${call.arguments.query}" (${matches.length}):\n${matches.join('\n')}`
      : `No matches found for "${call.arguments.query}".`;
    return {
      result,
      resultSummary: `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`,
      usedFiles: [...usedFiles],
      mutationCharacters: 0
    };
  }

  private readWorkspaceDiagnostics(
    call: Extract<ParsedAgentToolCall, { name: 'get_diagnostics' }>,
    folder: vscode.WorkspaceFolder
  ): {
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  } {
    const maxResults = Math.min(
      call.arguments.maxResults,
      this.callbacks.getAgentToolSettings().diagnosticsMaxResults
    );
    const diagnostics: Array<{
      severity: vscode.DiagnosticSeverity;
      path: string;
      line: number;
      column: number;
      source?: string;
      code?: string;
      message: string;
    }> = [];

    for (const [uri, fileDiagnostics] of vscode.languages.getDiagnostics()) {
      const diagnosticFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!diagnosticFolder || diagnosticFolder.uri.toString() !== folder.uri.toString()) {
        continue;
      }
      const relativePath = normalizeRelativeWorkspacePath(
        vscode.workspace.asRelativePath(uri, false)
      );
      if (shouldSkipProjectFile(relativePath)) {
        continue;
      }
      if (
        call.arguments.path
        && !agentPathMatches(relativePath, call.arguments.path)
        && !agentPathStartsWith(relativePath, call.arguments.path)
      ) {
        continue;
      }
      for (const diagnostic of fileDiagnostics) {
        if (
          diagnostic.severity !== vscode.DiagnosticSeverity.Error
          && diagnostic.severity !== vscode.DiagnosticSeverity.Warning
        ) {
          continue;
        }
        const rawCode = typeof diagnostic.code === 'object'
          ? diagnostic.code.value
          : diagnostic.code;
        diagnostics.push({
          severity: diagnostic.severity,
          path: relativePath,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          source: diagnostic.source,
          code: rawCode === undefined ? undefined : String(rawCode),
          message: diagnostic.message
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500)
        });
      }
    }

    diagnostics.sort((left, right) => left.severity - right.severity
      || left.path.localeCompare(right.path)
      || left.line - right.line
      || left.column - right.column);
    const selected = diagnostics.slice(0, maxResults);
    const errors = selected.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = selected.length - errors;
    const result = selected.length === 0
      ? `No VS Code errors or warnings were found${call.arguments.path ? ` under ${call.arguments.path}` : ' in the workspace'}.`
      : [
        `VS Code Problems (${selected.length}${diagnostics.length > selected.length ? ` of ${diagnostics.length}` : ''}):`,
        ...selected.map((item) => {
          const severity = item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          const owner = [item.source, item.code].filter(Boolean).join(' ');
          return `[${severity}] ${item.path}:${item.line}:${item.column}${owner ? ` (${owner})` : ''} ${item.message}`;
        })
      ].join('\n');
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  private async readDocumentSymbols(
    call: Extract<ParsedAgentToolCall, { name: 'get_symbols' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(folder, call.arguments.path);
    const configuredLimit = this.callbacks.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const provided = await vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
    >('vscode.executeDocumentSymbolProvider', source.document.uri);
    const rows: string[] = [];

    const visit = (
      symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
      containers: string[] = []
    ): void => {
      for (const symbol of symbols) {
        if (rows.length >= maxResults) {
          return;
        }
        if (isDocumentSymbol(symbol)) {
          const container = containers.join('.');
          rows.push(formatSymbolResult(
            symbol.kind,
            symbol.name,
            call.arguments.path,
            symbol.selectionRange.start,
            container
          ));
          visit(symbol.children, [...containers, symbol.name]);
          continue;
        }
        const location = this.workspaceCodeLocation(
          folder,
          symbol.location.uri,
          symbol.location.range
        );
        if (!location) {
          continue;
        }
        rows.push(formatSymbolResult(
          symbol.kind,
          symbol.name,
          location.path,
          new vscode.Position(location.line - 1, location.column - 1),
          symbol.containerName
        ));
      }
    };
    visit(Array.isArray(provided) ? provided : []);

    const result = rows.length > 0
      ? `Symbols in ${call.arguments.path} (${rows.length}):\n${rows.join('\n')}`
      : `No document symbols were available for ${call.arguments.path}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${rows.length} ${rows.length === 1 ? 'symbol' : 'symbols'}`,
      usedFiles: [source.filePath],
      mutationCharacters: 0
    };
  }

  private async findCodeLocations(
    call: Extract<ParsedAgentToolCall, { name: 'find_definition' | 'find_references' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(
      folder,
      call.arguments.path,
      call.arguments.line,
      call.arguments.column
    );
    const position = new vscode.Position(call.arguments.line - 1, call.arguments.column - 1);
    const provided = call.name === 'find_definition'
      ? await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeDefinitionProvider',
          source.document.uri,
          position
        )
      : await vscode.commands.executeCommand<vscode.Location[] | undefined>(
          'vscode.executeReferenceProvider',
          source.document.uri,
          position
        );
    const configuredLimit = this.callbacks.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const locations: WorkspaceCodeLocation[] = [];
    const seen = new Set<string>();
    for (const rawLocation of Array.isArray(provided) ? provided : []) {
      const providerLocation = codeLocationFromProvider(rawLocation);
      if (!providerLocation) {
        continue;
      }
      const location = this.workspaceCodeLocation(
        folder,
        providerLocation.uri,
        providerLocation.range
      );
      if (!location) {
        continue;
      }
      const signature = `${fileChangePathKey(location.path)}:${location.line}:${location.column}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      locations.push(location);
      if (locations.length >= maxResults) {
        break;
      }
    }

    const noun = call.name === 'find_definition' ? 'definition' : 'reference';
    const sourceLabel = `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`;
    const result = locations.length > 0
      ? `${noun === 'definition' ? 'Definitions' : 'References'} for ${sourceLabel} (${locations.length}):\n`
        + locations.map((location) => `${location.path}:${location.line}:${location.column}`).join('\n')
      : `No workspace ${noun}s were found for ${sourceLabel}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${locations.length} ${locations.length === 1 ? noun : `${noun}s`}`,
      usedFiles: [
        source.filePath,
        ...locations.map((location) => location.filePath)
      ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 20),
      mutationCharacters: 0
    };
  }

  private async openCodeNavigationSource(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    line?: number,
    column?: number
  ): Promise<{ document: vscode.TextDocument; filePath: string }> {
    await this.workspaceMutations.assertNoWorkspaceSymlink(folder, relativePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
    const candidate = await this.workspaceContext.readProjectCandidate(uri);
    if (
      !candidate
      || !agentPathMatches(normalizeRelativeWorkspacePath(candidate.relativePath), relativePath)
    ) {
      throw new Error('The code-navigation source does not exist or is excluded from DevMate context.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (line !== undefined) {
      if (line > document.lineCount) {
        throw new Error(`${relativePath} has only ${document.lineCount} lines.`);
      }
      const lineLength = document.lineAt(line - 1).text.length;
      if (column === undefined || column > lineLength + 1) {
        throw new Error(`Column ${column ?? ''} is outside line ${line} in ${relativePath}.`);
      }
    }
    return { document, filePath: candidate.filePath };
  }

  // Language servers may return dependency or outside-workspace locations; filter those out here.
  private workspaceCodeLocation(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
    range: vscode.Range
  ): WorkspaceCodeLocation | undefined {
    const locationFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!locationFolder || locationFolder.uri.toString() !== folder.uri.toString()) {
      return undefined;
    }
    const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }
    return {
      path: relativePath,
      line: range.start.line + 1,
      column: range.start.character + 1,
      filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString()
    };
  }

  private async deleteAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'delete_file' }>,
    folder: vscode.WorkspaceFolder,
    remainingMutationCharacters: number,
    signal: AbortSignal
  ) {
    return this.workspaceMutations.deleteFile(
      folder,
      call.arguments.path,
      remainingMutationCharacters,
      signal
    );
  }

  private async relocateAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'rename_file' | 'move_file' }>,
    folder: vscode.WorkspaceFolder,
    signal: AbortSignal
  ) {
    return this.workspaceMutations.relocateFile(
      folder,
      call.arguments.path,
      call.arguments.newPath,
      call.name === 'rename_file' ? 'rename' : 'move',
      signal
    );
  }

  private async runVerificationCommand(
    call: Extract<ParsedAgentToolCall, { name: 'run_command' }>,
    folder: vscode.WorkspaceFolder,
    signal: AbortSignal
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    commandAttempted: boolean;
  }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to run verification commands.');
    }
    const cwdUri = call.arguments.cwd
      ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
      : folder.uri;
    if (call.arguments.cwd) {
      await this.workspaceMutations.assertNoWorkspaceSymlink(folder, call.arguments.cwd, false);
    }
    if (call.arguments.executable.startsWith('./')) {
      await this.workspaceMutations.assertNoWorkspaceSymlink(
        folder,
        [call.arguments.cwd, call.arguments.executable.slice(2)].filter(Boolean).join('/'),
        false
      );
    }
    try {
      const stat = await vscode.workspace.fs.stat(cwdUri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        throw new Error('The command working directory is not a directory.');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Cannot use the command working directory: ${error.message}`
          : 'Cannot use the command working directory.'
      );
    }

    const requestedCommand: ValidatedCommand = call.arguments;
    const resolvedPython = await this.resolveWorkspacePythonCommand(requestedCommand, folder);
    const command = resolvedPython.command;
    const requestedLabel = commandLabel(requestedCommand);
    const label = resolvedPython.environment
      ? `${requestedLabel} · ${resolvedPython.environment}`
      : requestedLabel;
    const signature = commandSignature(command);
    const allowed = await this.callbacks.requestCommandPermission(signature, label, command.cwd);
    if (!allowed) {
      throw new Error('Permission to run the verification command was denied.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while command permission was pending; the command was not run.');
    }
    if (signal.aborted) {
      throw new Error('The verification command was cancelled.');
    }

    const configuredTimeout = vscode.workspace.getConfiguration('devMate').get<number>(
      'commandTimeoutSeconds',
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    );
    const timeoutSeconds = Math.min(
      command.timeoutSeconds,
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout)
    );
    const terminal = vscode.window.createTerminal({
      name: `DevMate: ${label.slice(0, 60)}`,
      cwd: cwdUri,
      isTransient: true
    });
    this.commandTerminals.set(call.id, terminal);
    const shellIntegration = await this.waitForShellIntegration(terminal, signal);
    if (!shellIntegration) {
      terminal.dispose();
      this.commandTerminals.delete(call.id);
      throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; the command was not run.');
    }

    const execution = shellIntegration.executeCommand(command.executable, command.args);
    const startedAt = Date.now();
    let output = '';
    const outputReader = (async () => {
      for await (const data of execution.read()) {
        output = sanitizeCommandOutput(output + data);
        this.callbacks.postAgentToolActivity(
          call.id,
          'Running verification command',
          label,
          'running',
          output,
          true
        );
      }
    })();

    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        endDisposable.dispose();
        resolve(value);
      };
      const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          finish({ state: 'completed', exitCode: event.exitCode });
        }
      });
      const cancel = () => {
        terminal.dispose();
        finish({ state: 'cancelled' });
      };
      const timeout = setTimeout(() => {
        terminal.dispose();
        finish({ state: 'timeout' });
      }, timeoutSeconds * 1_000);
      signal.addEventListener('abort', cancel, { once: true });
    });
    await Promise.race([outputReader, wait(250)]);
    const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
    const modelOutput = boundedModelCommandOutput(output);
    const result = [
      `Command: ${requestedLabel}`,
      ...(isPythonVerificationCommand(requestedCommand)
        ? [`Python environment: ${resolvedPython.environment ?? `PATH lookup (${requestedCommand.executable})`}`]
        : []),
      `Working directory: ${command.cwd || '.'}`,
      outcome.state === 'completed'
        ? `Exit code: ${outcome.exitCode ?? 'unknown'}`
        : outcome.state === 'timeout'
          ? `Timed out after ${timeoutSeconds} seconds`
          : 'Cancelled',
      `Duration: ${durationSeconds.toFixed(1)} seconds`,
      modelOutput ? `Output:\n${modelOutput}` : 'Output: (none)'
    ].join('\n');

    if (outcome.state === 'cancelled') {
      this.commandTerminals.delete(call.id);
      throw new StartedCommandError('The verification command was cancelled.');
    }
    if (outcome.state === 'timeout') {
      this.commandTerminals.delete(call.id);
      throw new StartedCommandError(result);
    }
    if (outcome.exitCode !== 0) {
      throw new StartedCommandError(
        result,
        extractMissingPythonModule(modelOutput),
        resolvedPython.environment
      );
    }
    return {
      result,
      resultSummary: `Passed in ${durationSeconds.toFixed(1)}s`,
      usedFiles: [],
      mutationCharacters: 0,
      commandAttempted: true
    };
  }

  private async runDependencyInstallation(
    call: Extract<ParsedAgentToolCall, { name: 'install_dependencies' }>,
    folder: vscode.WorkspaceFolder,
    signal: AbortSignal
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    installAttempted: boolean;
    environmentChanged: boolean;
  }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to install dependencies.');
    }
    if (folder.uri.scheme !== 'file') {
      throw new Error('Python dependency installation currently requires a local filesystem workspace.');
    }
    const initialManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    const cwdUri = call.arguments.cwd
      ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
      : folder.uri;
    const probeCommand: ValidatedCommand = {
      executable: process.platform === 'win32' ? 'py' : 'python3',
      args: [],
      cwd: call.arguments.cwd,
      timeoutSeconds: call.arguments.timeoutSeconds
    };
    const existingPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
    const targetEnvironment = [call.arguments.cwd, '.venv'].filter(Boolean).join('/');
    const willCreateEnvironment = !existingPython.environment;
    if (willCreateEnvironment) {
      const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(
          `${targetEnvironment} already exists but does not contain a supported Python interpreter. `
          + 'Repair or remove it manually before installing dependencies.'
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    }

    const environmentLabel = existingPython.environment ?? targetEnvironment;
    const requirementSummary = initialManifest.requirements.length === 1
      ? initialManifest.requirements[0]
      : `${initialManifest.requirements.length} requirements`;
    const allowed = await this.callbacks.requestCommandPermission(
      randomUUID(),
      `${willCreateEnvironment ? `Create ${targetEnvironment} and install` : 'Install'} ${requirementSummary} from ${call.arguments.manifestPath}`,
      call.arguments.cwd,
      {
        rememberable: false,
        title: 'Permission required to install Python dependencies',
        warning: 'This downloads packages and may execute package build or installation code. Installation is restricted to the validated manifest and project-local virtual environment.'
      }
    );
    if (!allowed) {
      throw new Error('Permission to install dependencies was denied.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while installation permission was pending; nothing was installed.');
    }
    // Consent applies to the reviewed dependency file, not a newer version saved during the prompt.
    const currentManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    if (currentManifest.content !== initialManifest.content) {
      throw new Error('The dependency manifest changed during approval; review the updated file and try again.');
    }

    let approvedPython = existingPython;
    if (willCreateEnvironment) {
      const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(
          `${targetEnvironment} appeared during approval; inspect it before trying again.`
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    } else {
      approvedPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
      if (approvedPython.environment !== existingPython.environment) {
        throw new Error('The selected Python environment changed during approval; inspect it and try again.');
      }
    }

    if (signal.aborted) {
      throw new Error('The dependency installation was cancelled.');
    }
    const configuredTimeout = vscode.workspace.getConfiguration('devMate').get<number>(
      'commandTimeoutSeconds',
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    );
    const timeoutSeconds = Math.min(
      call.arguments.timeoutSeconds,
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout)
    );
    const terminal = vscode.window.createTerminal({
      name: `DevMate: install ${path.posix.basename(call.arguments.manifestPath)}`,
      cwd: cwdUri,
      isTransient: true
    });
    this.commandTerminals.set(call.id, terminal);
    const shellIntegration = await this.waitForShellIntegration(terminal, signal);
    if (!shellIntegration) {
      terminal.dispose();
      this.commandTerminals.delete(call.id);
      throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; dependencies were not installed.');
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1_000;
    let combinedOutput = '';
    const runStep = async (executable: string, args: string[], label: string) => {
      const remainingMilliseconds = Math.max(1, deadline - Date.now());
      combinedOutput = sanitizeCommandOutput(`${combinedOutput}${combinedOutput ? '\n' : ''}> ${label}\n`);
      const step = await this.executeTerminalStep(
        terminal,
        shellIntegration,
        executable,
        args,
        remainingMilliseconds,
        signal,
        (output) => {
          combinedOutput = sanitizeCommandOutput(combinedOutput + output);
          this.callbacks.postAgentToolActivity(
            call.id,
            'Installing Python dependencies',
            `${call.arguments.manifestPath} → ${environmentLabel}`,
            'running',
            combinedOutput,
            true
          );
        }
      );
      if (step.state === 'cancelled') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError('The dependency installation was cancelled.');
      }
      if (step.state === 'timeout') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError(
          `Dependency installation timed out after ${timeoutSeconds} seconds.\n\n${boundedModelCommandOutput(combinedOutput)}`
        );
      }
      if (step.exitCode !== 0) {
        throw new StartedDependencyInstallError([
          `${label} failed with exit code ${step.exitCode ?? 'unknown'}.`,
          boundedModelCommandOutput(combinedOutput)
        ].join('\n\n'));
      }
    };

    let pythonExecutable = approvedPython.command.executable;
    if (willCreateEnvironment) {
      const launcher = process.platform === 'win32' ? 'py' : 'python3';
      await runStep(launcher, ['-m', 'venv', '.venv'], `${launcher} -m venv .venv`);
      const createdCandidate = workspacePythonCandidates(call.arguments.cwd)[0];
      await this.workspaceMutations.assertNoWorkspaceSymlink(folder, createdCandidate, false);
      const createdUri = vscode.Uri.joinPath(folder.uri, ...createdCandidate.split('/'));
      const createdStat = await vscode.workspace.fs.stat(createdUri);
      if ((createdStat.type & vscode.FileType.File) === 0) {
        throw new StartedDependencyInstallError('The virtual environment was created without a usable Python interpreter.');
      }
      pythonExecutable = workspacePythonExecutable(createdCandidate, call.arguments.cwd);
    }

    const manifestName = path.posix.basename(call.arguments.manifestPath);
    await runStep(
      pythonExecutable,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', manifestName],
      `${environmentLabel} -m pip install -r ${manifestName}`
    );
    const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
    const result = [
      `Manifest: ${call.arguments.manifestPath}`,
      `Python environment: ${environmentLabel}`,
      `Installed requirements: ${initialManifest.requirements.join(', ')}`,
      `Duration: ${durationSeconds.toFixed(1)} seconds`,
      boundedModelCommandOutput(combinedOutput)
    ].join('\n');
    return {
      result,
      resultSummary: `Installed ${initialManifest.requirements.length} ${initialManifest.requirements.length === 1 ? 'requirement' : 'requirements'} into ${environmentLabel}`,
      usedFiles: [initialManifest.uri.fsPath],
      mutationCharacters: 0,
      installAttempted: true,
      environmentChanged: true
    };
  }

  private async readDependencyManifest(
    folder: vscode.WorkspaceFolder,
    manifestPath: string
  ): Promise<{ uri: vscode.Uri; content: string; requirements: string[] }> {
    await this.workspaceMutations.assertNoWorkspaceSymlink(folder, manifestPath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...manifestPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    if (openDocument?.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${manifestPath} before installing dependencies.`);
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_DEPENDENCY_MANIFEST_BYTES) {
      throw new Error('The dependency manifest is not a supported text file or exceeds 64 KB.');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsBinaryData(bytes)) {
      throw new Error('The dependency manifest contains binary data.');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('The dependency manifest must be valid UTF-8 text.');
    }
    return {
      uri,
      content,
      requirements: validatePythonRequirementsManifest(content)
    };
  }

  // Wait for shell-integration completion rather than guessing success from terminal text.
  private async executeTerminalStep(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    executable: string,
    args: string[],
    timeoutMilliseconds: number,
    signal: AbortSignal,
    onOutput: (output: string) => void
  ): Promise<{ state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }> {
    const execution = shellIntegration.executeCommand(executable, args);
    const outputReader = (async () => {
      for await (const data of execution.read()) {
        onOutput(data);
      }
    })();
    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        endDisposable.dispose();
        resolve(value);
      };
      const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          finish({ state: 'completed', exitCode: event.exitCode });
        }
      });
      const cancel = () => {
        terminal.dispose();
        finish({ state: 'cancelled' });
      };
      const timeout = setTimeout(() => {
        terminal.dispose();
        finish({ state: 'timeout' });
      }, timeoutMilliseconds);
      signal.addEventListener('abort', cancel, { once: true });
    });
    await Promise.race([outputReader, wait(250)]);
    return outcome;
  }

  private async resolveWorkspacePythonCommand(
    command: ValidatedCommand,
    folder: vscode.WorkspaceFolder
  ): Promise<{ command: ValidatedCommand; environment?: string }> {
    if (!isPythonVerificationCommand(command) || folder.uri.scheme !== 'file') {
      return { command };
    }
    for (const candidate of workspacePythonCandidates(command.cwd)) {
      try {
        await this.workspaceMutations.assertNoWorkspaceSymlink(folder, candidate, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...candidate.split('/'));
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          return {
            command: {
              ...command,
              executable: workspacePythonExecutable(candidate, command.cwd)
            },
            environment: candidate
          };
        }
      } catch {
        // Missing, inaccessible, and symbolic-link environments are ignored safely.
      }
    }
    return { command };
  }

  captureWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionStartEvent
  ): void {
    if (event.terminal.name.startsWith('DevMate:')) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const cwd = event.execution.cwd;
    if (!folder || !cwd) {
      return;
    }
    const cwdWorkspace = vscode.workspace.getWorkspaceFolder(cwd);
    if (!cwdWorkspace || cwdWorkspace.uri.toString() !== folder.uri.toString()) {
      return;
    }

    const capture: ActiveTerminalCapture = {
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value),
      cwd: normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(cwd, false)),
      terminalName: sanitizeCapturedTerminalText(event.terminal.name),
      output: ''
    };
    this.activeTerminalCaptures.set(event.execution, capture);
    capture.reader = (async () => {
      try {
        for await (const data of event.execution.read()) {
          capture.output = sanitizeCapturedTerminalText(capture.output + data);
        }
      } catch {
        // Terminal output is optional context. Failed capture must not affect the terminal.
      }
    })();
  }

  async finishWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionEndEvent
  ): Promise<void> {
    const capture = this.activeTerminalCaptures.get(event.execution);
    if (!capture) {
      return;
    }
    this.activeTerminalCaptures.delete(event.execution);
    if (capture.reader) {
      await Promise.race([capture.reader, wait(250)]);
    }
    if (event.exitCode === undefined || event.exitCode === 0) {
      return;
    }

    this.recentTerminalErrors.unshift({
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value) || capture.command,
      cwd: capture.cwd,
      terminalName: capture.terminalName,
      exitCode: event.exitCode,
      output: sanitizeCapturedTerminalText(capture.output),
      capturedAt: Date.now()
    });
    this.recentTerminalErrors.splice(MAX_CAPTURED_TERMINAL_ERRORS);
  }

  // Shell integration is asynchronous and optional; bound the wait instead of hanging the request.
  private waitForShellIntegration(
    terminal: vscode.Terminal,
    signal: AbortSignal
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise((resolve) => {
      const finish = (integration?: vscode.TerminalShellIntegration) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        disposable.dispose();
        resolve(integration);
      };
      const cancel = () => finish();
      const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
          finish(event.shellIntegration);
        }
      });
      const timeout = setTimeout(() => finish(), 5_000);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  disposeCommandTerminals(): void {
    for (const terminal of this.commandTerminals.values()) {
      terminal.dispose();
    }
    this.commandTerminals.clear();
  }

  private async findAgentFiles(
    folder: vscode.WorkspaceFolder,
    requestedPath: string
  ): Promise<vscode.Uri[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_ATTACHMENT_CANDIDATES
    );
    return uris
      .filter((uri) => {
        const relativePath = normalizeRelativeWorkspacePath(
          vscode.workspace.asRelativePath(uri, false)
        );
        return !shouldSkipProjectFile(relativePath)
          && (!requestedPath
            || agentPathMatches(relativePath, requestedPath)
            || agentPathStartsWith(relativePath, requestedPath));
      })
      .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      ))
      .slice(0, MAX_PROJECT_CANDIDATES);
  }
}

function fileChangePathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function agentPathMatches(left: string, right: string): boolean {
  return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}

function agentPathStartsWith(filePath: string, directoryPath: string): boolean {
  return comparableWorkspacePath(filePath).startsWith(
    `${comparableWorkspacePath(directoryPath)}/`
  );
}

function comparableWorkspacePath(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol && Array.isArray(symbol.children);
}

function codeLocationFromProvider(
  location: vscode.Location | vscode.LocationLink
): { uri: vscode.Uri; range: vscode.Range } | undefined {
  if ('targetUri' in location) {
    return {
      uri: location.targetUri,
      range: location.targetSelectionRange ?? location.targetRange
    };
  }
  if ('uri' in location) {
    return { uri: location.uri, range: location.range };
  }
  return undefined;
}

function formatSymbolResult(
  kind: vscode.SymbolKind,
  name: string,
  filePath: string,
  position: vscode.Position,
  container?: string
): string {
  const kindLabel = vscode.SymbolKind[kind] ?? 'Symbol';
  const safeName = boundedCodeNavigationText(name, 160) || '(unnamed)';
  const safeContainer = boundedCodeNavigationText(container, 160);
  return `[${kindLabel}] ${safeName}${safeContainer ? ` · ${safeContainer}` : ''} — `
    + `${filePath}:${position.line + 1}:${position.character + 1}`;
}

function boundedCodeNavigationText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function describeAgentToolCall(call: ParsedAgentToolCall): { title: string; detail: string } {
  if (call.name === 'list_files') {
    return {
      title: 'Listing project files',
      detail: call.arguments.path || 'Project root'
    };
  }
  if (call.name === 'read_file') {
    return {
      title: 'Reading file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'get_diagnostics') {
    return {
      title: 'Reading workspace diagnostics',
      detail: call.arguments.path || 'All workspace Problems'
    };
  }
  if (call.name === 'get_symbols') {
    return {
      title: 'Reading file symbols',
      detail: call.arguments.path
    };
  }
  if (call.name === 'find_definition') {
    return {
      title: 'Finding definition',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'find_references') {
    return {
      title: 'Finding references',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'read_terminal_errors') {
    return {
      title: 'Reading recent terminal errors',
      detail: `Up to ${call.arguments.maxResults} failed commands`
    };
  }
  if (call.name === 'create_file') {
    return {
      title: 'Creating file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'edit_file') {
    return {
      title: 'Editing file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'delete_file') {
    return {
      title: 'Deleting file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'rename_file') {
    return {
      title: 'Renaming file',
      detail: `${call.arguments.path} → ${call.arguments.newPath}`
    };
  }
  if (call.name === 'move_file') {
    return {
      title: 'Moving file',
      detail: `${call.arguments.path} → ${call.arguments.newPath}`
    };
  }
  if (call.name === 'install_dependencies') {
    return {
      title: 'Installing Python dependencies',
      detail: call.arguments.manifestPath
    };
  }
  if (call.name === 'run_command') {
    return {
      title: 'Running verification command',
      detail: call.arguments.executable
    };
  }
  return {
    title: 'Searching code',
    detail: `"${call.arguments.query}"${call.arguments.path ? ` in ${call.arguments.path}` : ''}`
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
