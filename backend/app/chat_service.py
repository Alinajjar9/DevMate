import json
from collections.abc import Sequence

from .api_models import (
    MUTATING_AGENT_TOOLS,
    READ_ONLY_AGENT_TOOLS,
    AgentToolCall,
    AgentToolName,
    AskData,
    AskRequest,
    AskResult,
    AskScope,
    FileChange,
    TokenUsage,
)
from .code_changes import CodeChangeParseError, parse_code_change_response
from .errors import BackendApiError
from .prompts import build_chat_messages
from .providers import ChatCompletion, ChatCompletionRequest, ChatToolDefinition
from .text_tool_calls import looks_like_text_tool_call, parse_text_tool_calls


class ChatService:
    def __init__(self, tool_definitions: Sequence[ChatToolDefinition]) -> None:
        self._tool_definitions = tuple(tool_definitions)

    def build_completion_request(
        self,
        request: AskRequest,
        provider_api_key: str | None,
    ) -> tuple[ChatCompletionRequest, tuple[AgentToolName, ...], list[str]]:
        used_files = self._used_files(request.scope)
        api_key = provider_api_key.strip() if provider_api_key else None
        requested_tools = (
            tuple(request.enabledTools)
            if request.enabledTools is not None
            else READ_ONLY_AGENT_TOOLS if request.toolsEnabled else ()
        )
        mode_tools = READ_ONLY_AGENT_TOOLS if request.mode == "ideas" else (
            *READ_ONLY_AGENT_TOOLS,
            *MUTATING_AGENT_TOOLS,
        )
        enabled_tools = tuple(
            tool for tool in requested_tools if tool in mode_tools
        ) if not request.forceFinalAnswer else ()
        messages = build_chat_messages(
            mode=request.mode,
            scope_type=request.scope.type,
            question=request.question,
            context_items=request.scope.items,
            tool_steps=request.toolHistory,
            tools_enabled=bool(enabled_tools),
            force_final_answer=request.forceFinalAnswer,
            disable_thinking=request.disableThinking,
            agent_edits_enabled=request.agentEditsEnabled,
            conversation_turns=request.conversationHistory,
            conversation_summary=request.conversationSummary,
        )
        return ChatCompletionRequest(
            provider=request.settings.provider,
            model=request.settings.model,
            base_url=request.settings.baseUrl,
            api_key=api_key if request.settings.provider == "openai" else None,
            messages=messages,
            max_tokens=request.settings.maxTokens,
            temperature=request.settings.temperature,
            reasoning_effort=request.settings.reasoningEffort,
            timeout_seconds=request.settings.timeoutSeconds,
            tools=tuple(
                definition
                for definition in self._tool_definitions
                if definition.name in enabled_tools
            ),
            force_final_answer=request.forceFinalAnswer,
            disable_thinking=request.disableThinking,
        ), enabled_tools, used_files

    def result_from_completion(
        self,
        request: AskRequest,
        completion: ChatCompletion,
        enabled_tools: tuple[AgentToolName, ...],
        used_files: list[str],
        token_usage: TokenUsage,
    ) -> AskResult:
        completion, _ = self.normalize_text_tool_completion(completion)
        if completion.tool_calls:
            if not enabled_tools:
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    "The model requested another tool when DevMate required a final answer.",
                )
            tool_calls = self._parse_agent_tool_calls(
                completion.tool_calls,
                set(enabled_tools),
            )
            history_call_ids = {step.callId for step in request.toolHistory}
            if any(tool_call.id in history_call_ids for tool_call in tool_calls):
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    "The model reused an invalid tool-call id.",
                )
            return AskResult(
                status="ok",
                data=AskData(
                    answer="",
                    usedFiles=used_files,
                    toolCalls=tool_calls,
                    tokenUsage=token_usage,
                ),
            )

        answer = completion.content
        if not answer:
            if completion.reasoning_content or completion.finish_reason in {"length", "max_tokens"}:
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    (
                        "The model used its response budget for reasoning without producing "
                        "a final answer. Increase devMate.maxTokens or try again."
                    ),
                )
            raise BackendApiError(
                502,
                "model_invalid_response",
                "The model provider returned an empty final answer.",
            )

        changes: list[FileChange] = []
        if request.mode == "code" and not request.agentEditsEnabled:
            try:
                answer, parsed_changes = parse_code_change_response(answer)
            except CodeChangeParseError as error:
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    str(error),
                ) from error
            changes = [
                FileChange(path=change.path, content=change.content)
                for change in parsed_changes
            ]

        return AskResult(
            status="ok",
            data=AskData(
                answer=answer,
                usedFiles=used_files,
                changes=changes,
                tokenUsage=token_usage,
            ),
        )

    def normalize_text_tool_completion(
        self,
        completion: ChatCompletion,
    ) -> tuple[ChatCompletion, bool]:
        if completion.tool_calls or not completion.content:
            return completion, False
        if not looks_like_text_tool_call(completion.content):
            return completion, False
        tool_calls = parse_text_tool_calls(completion.content)
        if not tool_calls:
            raise BackendApiError(
                502,
                "model_invalid_response",
                "The model returned a malformed textual tool call.",
            )
        return ChatCompletion(
            content=None,
            tool_calls=tool_calls,
            finish_reason=completion.finish_reason,
            reasoning_content=completion.reasoning_content,
            usage=completion.usage,
        ), True

    def completion_token_usage(
        self,
        request: ChatCompletionRequest,
        completion: ChatCompletion | None,
    ) -> TokenUsage:
        if completion and completion.usage:
            return TokenUsage(
                inputTokens=completion.usage.input_tokens,
                outputTokens=completion.usage.output_tokens,
                totalTokens=completion.usage.total_tokens,
                exact=True,
            )

        input_characters = 0
        for message in request.messages:
            input_characters += len(message.role) + len(message.content or "")
            input_characters += len(message.tool_call_id or "")
            for tool_call in message.tool_calls:
                input_characters += len(tool_call.id) + len(tool_call.name) + len(tool_call.arguments)
        for tool in request.tools:
            input_characters += len(tool.name) + len(tool.description)
            input_characters += len(json.dumps(
                tool.parameters,
                separators=(",", ":"),
                ensure_ascii=False,
            ))

        output_characters = 0
        if completion:
            output_characters += len(completion.content or "")
            output_characters += len(completion.reasoning_content or "")
            for tool_call in completion.tool_calls:
                output_characters += len(tool_call.id) + len(tool_call.name) + len(tool_call.arguments)
        input_tokens = self._estimated_token_count(input_characters)
        output_tokens = self._estimated_token_count(output_characters)
        return TokenUsage(
            inputTokens=input_tokens,
            outputTokens=output_tokens,
            totalTokens=input_tokens + output_tokens,
            exact=False,
        )

    @staticmethod
    def _estimated_token_count(character_count: int) -> int:
        return 0 if character_count <= 0 else max(1, (character_count + 3) // 4)

    @staticmethod
    def _parse_agent_tool_calls(
        tool_calls: tuple[object, ...],
        enabled_tools: set[AgentToolName],
    ) -> list[AgentToolCall]:
        parsed_calls: list[AgentToolCall] = []
        seen_ids: set[str] = set()
        for tool_call in tool_calls:
            call_id = getattr(tool_call, "id", "")
            name = getattr(tool_call, "name", "")
            arguments_json = getattr(tool_call, "arguments", "")
            if (
                not isinstance(call_id, str)
                or not call_id
                or len(call_id) > 120
                or call_id in seen_ids
                or name not in enabled_tools
                or not isinstance(arguments_json, str)
                or len(arguments_json) > 1_200_000
            ):
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    "The model requested an invalid tool.",
                )
            try:
                arguments = json.loads(arguments_json)
            except (TypeError, json.JSONDecodeError) as error:
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    "The model returned invalid tool arguments.",
                ) from error
            if not isinstance(arguments, dict):
                raise BackendApiError(
                    502,
                    "model_invalid_response",
                    "The model returned invalid tool arguments.",
                )
            seen_ids.add(call_id)
            parsed_calls.append(
                AgentToolCall(id=call_id, name=name, arguments=arguments)
            )
        return parsed_calls

    @staticmethod
    def _used_files(scope: AskScope) -> list[str]:
        return list(dict.fromkeys(item.filePath for item in scope.items))
