import json
import unittest

from fastapi.testclient import TestClient

from backend.app.main import (
    MAX_ATTACHED_FILES,
    MAX_CONTEXT_CHARACTERS,
    MAX_PROJECT_CONTEXT_FILES,
    MAX_PROJECT_FILE_CHARACTERS,
    app,
    get_chat_provider,
)
from backend.app.providers import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatToolCall,
    ProviderError,
)


class RecordingProvider:
    def __init__(self) -> None:
        self.requests: list[ChatCompletionRequest] = []
        self.error: ProviderError | None = None
        self.answer: str | ChatCompletion = "Mock provider answer"

    async def complete(self, request: ChatCompletionRequest) -> str | ChatCompletion:
        self.requests.append(request)
        if self.error:
            raise self.error
        return self.answer


class DevMateApiTests(unittest.TestCase):
    provider = RecordingProvider()
    client = TestClient(
        app,
        headers={"X-DevMate-Provider-Key": "test-provider-key"},
    )

    @classmethod
    def setUpClass(cls) -> None:
        app.dependency_overrides[get_chat_provider] = lambda: cls.provider

    @classmethod
    def tearDownClass(cls) -> None:
        app.dependency_overrides.clear()

    def setUp(self) -> None:
        self.provider.requests.clear()
        self.provider.error = None
        self.provider.answer = "Mock provider answer"

    def test_health_reports_online_backend(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "data": {"backend": "online", "version": "0.7.0"},
            },
        )

    def test_ask_uses_selection_context(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="selection",
                items=[
                    self._context_item(
                        source="selection",
                        content="return 42;",
                        file_path="C:\\repo\\src\\app.ts",
                    )
                ],
            ),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["data"]["usedFiles"], ["C:\\repo\\src\\app.ts"])
        self.assertEqual(payload["data"]["answer"], "Mock provider answer")
        provider_request = self.provider.requests[-1]
        self.assertEqual(provider_request.api_key, "test-provider-key")
        self.assertEqual(provider_request.timeout_seconds, 900)
        self.assertIn("Question:\nWhat does this code do?", provider_request.messages[1].content)
        self.assertIn("Source: selection", provider_request.messages[1].content)
        self.assertIn("return 42;", provider_request.messages[1].content)

    def test_ask_passes_a_bounded_provider_timeout(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["settings"]["timeoutSeconds"] = 1_200

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider.requests[-1].timeout_seconds, 1_200)

        payload["settings"]["timeoutSeconds"] = 1_801
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_selection_scope_accepts_workspace_attachment(self) -> None:
        items = [
            self._context_item(
                source="selection",
                content="return 42;",
                file_path="C:\\repo\\src\\app.ts",
            ),
            self._context_item(
                source="attachment",
                content="export const config = {};",
                file_path="C:\\repo\\src\\config.ts",
            ),
        ]
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="selection", items=items),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()["data"]
        self.assertEqual(
            payload["usedFiles"],
            ["C:\\repo\\src\\app.ts", "C:\\repo\\src\\config.ts"],
        )
        prompt = self.provider.requests[-1].messages[1].content
        self.assertIn("Source: attachment", prompt)
        self.assertIn("export const config = {};", prompt)

    def test_scope_rejects_too_many_attachments(self) -> None:
        items = [self._context_item(source="selection", content="return 42;")]
        items.extend(
            self._context_item(
                source="attachment",
                content=f"attachment {index}",
                file_path=f"C:\\repo\\src\\attachment{index}.ts",
            )
            for index in range(MAX_ATTACHED_FILES + 1)
        )
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="selection", items=items),
        )

        self.assertEqual(response.status_code, 422)

    def test_scope_rejects_oversized_attachment(self) -> None:
        items = [
            self._context_item(source="file", content="export const app = {};"),
            self._context_item(
                source="attachment",
                content="a" * (MAX_PROJECT_FILE_CHARACTERS + 1),
                file_path="C:\\repo\\src\\large.ts",
            ),
        ]
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=items),
        )

        self.assertEqual(response.status_code, 422)

    def test_scope_rejects_excessive_combined_context(self) -> None:
        items = [self._context_item(source="file", content="a" * 20_000)]
        items.extend(
            self._context_item(
                source="attachment",
                content="b" * 8_000,
                file_path=f"C:\\repo\\src\\attachment{index}.ts",
            )
            for index in range(3)
        )
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=items),
        )

        self.assertEqual(response.status_code, 422)

    def test_ask_uses_normal_file_context(self) -> None:
        content = "export const answer = 42;"
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content=content)],
            ),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["data"]["usedFiles"], ["C:\\repo\\src\\app.ts"])
        prompt = self.provider.requests[-1].messages[1].content
        self.assertIn("Source: file", prompt)
        self.assertIn("Path: C:\\repo\\src\\app.ts", prompt)
        self.assertIn(content, prompt)

    def test_ask_accepts_empty_file_context(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content="")],
            ),
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Content:\n\n--- END CONTEXT", self.provider.requests[-1].messages[1].content)

    def test_ask_accepts_truncated_file_context(self) -> None:
        content = "a" * MAX_CONTEXT_CHARACTERS
        item = self._context_item(source="file", content=content)
        item["totalCharacters"] = MAX_CONTEXT_CHARACTERS + 500
        item["truncated"] = True

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=[item]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Truncated: yes", self.provider.requests[-1].messages[1].content)

    def test_ask_rejects_unbounded_file_content(self) -> None:
        content = "a" * (MAX_CONTEXT_CHARACTERS + 1)
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content=content)],
            ),
        )

        self.assertEqual(response.status_code, 422)

    def test_ask_rejects_incorrect_character_metadata(self) -> None:
        item = self._context_item(source="file", content="hello")
        item["includedCharacters"] = 4

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=[item]),
        )

        self.assertEqual(response.status_code, 422)

    def test_project_scope_does_not_report_workspace_as_used_file(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["usedFiles"], [])

    def test_project_scope_reports_ranked_context_files(self) -> None:
        items = [
            self._context_item(
                source="file",
                content="export function login() {}",
                file_path="C:\\repo\\src\\auth.ts",
            ),
            self._context_item(
                source="file",
                content="# Authentication",
                file_path="C:\\repo\\README.md",
            ),
        ]
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=items),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["data"]["usedFiles"],
            ["C:\\repo\\src\\auth.ts", "C:\\repo\\README.md"],
        )

    def test_project_scope_rejects_too_many_files(self) -> None:
        items = [
            self._context_item(
                source="file",
                content=f"file {index}",
                file_path=f"C:\\repo\\src\\file{index}.ts",
            )
            for index in range(MAX_PROJECT_CONTEXT_FILES + 1)
        ]
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=items),
        )

        self.assertEqual(response.status_code, 422)

    def test_project_scope_rejects_excessive_total_context(self) -> None:
        items = [
            self._context_item(
                source="file",
                content="a" * 15_000,
                file_path=f"C:\\repo\\src\\file{index}.ts",
            )
            for index in range(3)
        ]
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=items),
        )

        self.assertEqual(response.status_code, 422)

    def test_project_scope_rejects_oversized_individual_file(self) -> None:
        item = self._context_item(
            source="file",
            content="a" * (MAX_PROJECT_FILE_CHARACTERS + 1),
        )
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[item]),
        )

        self.assertEqual(response.status_code, 422)

    def test_provider_errors_are_returned_without_a_fake_answer(self) -> None:
        self.provider.error = ProviderError("The provider rate limit was reached.", 429)

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.json(),
            {"detail": "The provider rate limit was reached."},
        )

    def test_ask_returns_validated_read_only_tool_calls(self) -> None:
        self.provider.answer = ChatCompletion(
            content=None,
            tool_calls=(
                ChatToolCall(
                    id="call-1",
                    name="search_code",
                    arguments='{"query":"permission","path":"src"}',
                ),
            ),
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["answer"], "")
        self.assertEqual(data["changes"], [])
        self.assertEqual(
            data["toolCalls"],
            [
                {
                    "id": "call-1",
                    "name": "search_code",
                    "arguments": {"query": "permission", "path": "src"},
                }
            ],
        )
        self.assertEqual(len(self.provider.requests[-1].tools), 3)

    def test_ask_replays_tool_history_and_can_disable_more_tools(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["toolsEnabled"] = False
        payload["forceFinalAnswer"] = True
        payload["toolHistory"] = [
            {
                "callId": "call-1",
                "name": "read_file",
                "arguments": {"path": "src/app.ts"},
                "result": "export const answer = 42;",
                "isError": False,
            }
        ]

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        provider_request = self.provider.requests[-1]
        self.assertEqual(provider_request.tools, ())
        self.assertTrue(provider_request.force_final_answer)
        self.assertIn("prior turn did not produce", provider_request.messages[0].content)
        self.assertEqual(provider_request.messages[-2].role, "assistant")
        self.assertEqual(provider_request.messages[-2].tool_calls[0].id, "call-1")
        self.assertEqual(provider_request.messages[-1].role, "tool")
        self.assertIn("answer = 42", provider_request.messages[-1].content)

    def test_ask_explains_reasoning_only_responses(self) -> None:
        self.provider.answer = ChatCompletion(
            content=None,
            finish_reason="length",
            reasoning_content="Internal reasoning only",
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.json(),
            {
                "detail": (
                    "The model used its response budget for reasoning without producing "
                    "a final answer. Increase devMate.maxTokens or try again."
                )
            },
        )

    def test_ask_rejects_model_requested_unsupported_tools(self) -> None:
        self.provider.answer = ChatCompletion(
            content=None,
            tool_calls=(
                ChatToolCall(
                    id="call-unsafe",
                    name="run_terminal",
                    arguments='{"command":"npm test"}',
                ),
            ),
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "The model requested an invalid tool."})

    def test_code_mode_returns_validated_workspace_changes(self) -> None:
        self.provider.answer = json.dumps(
            {
                "summary": "Added a greeting module.",
                "changes": [
                    {
                        "path": "src/greeting.ts",
                        "content": "export const greeting = 'hello';\n",
                    }
                ],
            }
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[], mode="code"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()["data"]
        self.assertEqual(payload["answer"], "Added a greeting module.")
        self.assertEqual(
            payload["changes"],
            [
                {
                    "path": "src/greeting.ts",
                    "content": "export const greeting = 'hello';\n",
                }
            ],
        )
        self.assertIn(
            "Return only one JSON object",
            self.provider.requests[-1].messages[0].content,
        )

    @staticmethod
    def _ask_payload(
        scope_type: str,
        items: list[dict[str, object]],
        mode: str = "ideas",
    ) -> dict[str, object]:
        return {
            "question": "What does this code do?",
            "mode": mode,
            "scope": {
                "type": scope_type,
                "workspacePath": "C:\\repo",
                "items": items,
            },
            "settings": {
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "maxTokens": 1200,
                "temperature": 0.2,
            },
        }

    @staticmethod
    def _context_item(
        source: str,
        content: str,
        file_path: str = "C:\\repo\\src\\app.ts",
    ) -> dict[str, object]:
        return {
            "source": source,
            "filePath": file_path,
            "languageId": "typescript",
            "content": content,
            "includedCharacters": len(content),
            "totalCharacters": len(content),
            "truncated": False,
        }


if __name__ == "__main__":
    unittest.main()
