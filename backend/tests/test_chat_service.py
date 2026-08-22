import unittest

from backend.app.api_models import AskRequest, TokenUsage
from backend.app.chat_service import ChatService
from backend.app.providers import ChatCompletion, ChatToolCall, ChatToolDefinition


class ChatServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = ChatService((
            ChatToolDefinition(
                name="read_file",
                description="Read one file.",
                parameters={"type": "object"},
            ),
            ChatToolDefinition(
                name="edit_file",
                description="Edit one file.",
                parameters={"type": "object"},
            ),
        ))

    def test_builds_a_bounded_provider_request_from_validated_input(self) -> None:
        request = self._request(
            mode="ideas",
            enabled_tools=["read_file", "edit_file"],
            items=[
                self._context_item("src/app.py", "first"),
                self._context_item("src/app.py", "second"),
            ],
        )

        completion_request, enabled_tools, used_files = (
            self.service.build_completion_request(request, "  provider-key  ")
        )

        self.assertEqual(enabled_tools, ("read_file",))
        self.assertEqual([tool.name for tool in completion_request.tools], ["read_file"])
        self.assertEqual(completion_request.api_key, "provider-key")
        self.assertEqual(used_files, ["src/app.py"])

    def test_normalizes_a_valid_tool_completion_into_an_api_result(self) -> None:
        request = self._request(
            mode="debug",
            enabled_tools=["read_file"],
            items=[],
        )
        completion = ChatCompletion(
            content=None,
            tool_calls=(
                ChatToolCall(
                    id="call-1",
                    name="read_file",
                    arguments='{"path":"src/app.py"}',
                ),
            ),
        )

        result = self.service.result_from_completion(
            request,
            completion,
            ("read_file",),
            [],
            TokenUsage(
                inputTokens=10,
                outputTokens=5,
                totalTokens=15,
                exact=True,
            ),
        )

        self.assertEqual(result.data.answer, "")
        self.assertEqual(result.data.toolCalls[0].id, "call-1")
        self.assertEqual(result.data.toolCalls[0].name, "read_file")
        self.assertEqual(
            result.data.toolCalls[0].arguments,
            {"path": "src/app.py"},
        )

    @staticmethod
    def _request(
        *,
        mode: str,
        enabled_tools: list[str],
        items: list[dict[str, object]],
    ) -> AskRequest:
        return AskRequest.model_validate({
            "question": "Inspect the project.",
            "mode": mode,
            "scope": {
                "type": "project",
                "workspacePath": "C:\\repo",
                "items": items,
            },
            "settings": {
                "provider": "openai",
                "model": "test-model",
                "baseUrl": "https://example.com/v1",
                "maxTokens": 1_000,
                "temperature": 0.2,
            },
            "enabledTools": enabled_tools,
        })

    @staticmethod
    def _context_item(path: str, content: str) -> dict[str, object]:
        return {
            "source": "file",
            "filePath": path,
            "languageId": "python",
            "content": content,
            "includedCharacters": len(content),
            "totalCharacters": len(content),
            "truncated": False,
        }


if __name__ == "__main__":
    unittest.main()
