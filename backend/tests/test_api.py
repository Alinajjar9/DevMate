import copy
import json
import unittest
from typing import get_args

from fastapi.testclient import TestClient

from backend.app.main import (
    MAX_AGENT_TOOL_STEPS,
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
    ChatStreamEvent,
    ChatTokenUsage,
    ChatToolCall,
    ProviderError,
)

from backend.app.tool_catalog import (
    AGENT_TOOL_DEFINITIONS,
    MUTATING_AGENT_TOOLS,
    READ_ONLY_AGENT_TOOLS,
    AgentToolName,
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
                "data": {"backend": "online", "version": "1.0.0"},
            },
        )

    def test_bounded_user_instructions_reach_both_provider_endpoints(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["instructions"] = "Preserve public function names."
        for endpoint in ("/ask", "/ask/stream"):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(endpoint, json=payload)
                self.assertEqual(response.status_code, 200)
                messages = self.provider.requests[-1].messages
                self.assertTrue(any(message.role == "user" and "Preserve public function names." in (message.content or "") for message in messages))
                self.assertNotIn("Preserve public function names.", messages[0].content)
        payload["instructions"] = "x" * 12_001
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_every_supported_agent_tool_has_one_definition(self) -> None:
        supported = set(get_args(AgentToolName))
        classified = set((*READ_ONLY_AGENT_TOOLS, *MUTATING_AGENT_TOOLS))
        definitions = [definition.name for definition in AGENT_TOOL_DEFINITIONS]

        self.assertEqual(classified, supported)
        self.assertEqual(set(definitions), supported)
        self.assertEqual(len(definitions), len(supported))

    def test_stream_endpoint_emits_start_delta_and_validated_final_result(self) -> None:
        with self.client.stream(
            "POST",
            "/ask/stream",
            json=self._ask_payload(scope_type="project", items=[]),
        ) as response:
            events = [json.loads(line) for line in response.iter_lines() if line]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/x-ndjson")
        self.assertEqual(events[0], {"type": "start"})
        self.assertEqual(events[1]["type"], "usage")
        self.assertFalse(events[1]["usage"]["exact"])
        self.assertGreater(events[1]["usage"]["inputTokens"], 0)
        self.assertIn({"type": "delta", "text": "Mock provider answer"}, events)
        self.assertEqual(events[-1]["type"], "final")
        self.assertEqual(events[-1]["result"]["data"]["answer"], "Mock provider answer")
        self.assertGreater(events[-1]["result"]["data"]["tokenUsage"]["totalTokens"], 0)

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
        payload["settings"]["reasoningEffort"] = "high"

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider.requests[-1].timeout_seconds, 1_200)
        self.assertEqual(self.provider.requests[-1].reasoning_effort, "high")

        payload["settings"]["timeoutSeconds"] = 1_801
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_ask_accepts_explicit_reasoning_off_for_luna(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["settings"]["model"] = "gpt-5.6-luna"
        payload["settings"]["reasoningEffort"] = "none"

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider.requests[-1].reasoning_effort, "none")

    def test_api_selection_defaults_to_auto_and_preserves_explicit_choice(self) -> None:
        for api in (None, "auto", "chat_completions", "responses"):
            with self.subTest(api=api):
                payload = self._ask_payload(scope_type="project", items=[])
                if api is not None:
                    payload["settings"]["api"] = api
                response = self.client.post("/ask", json=payload)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.provider.requests[-1].api, api or "auto")

        payload["settings"]["api"] = "unsupported"
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_api_accepts_max_reasoning_for_responses(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["settings"].update(api="responses", model="gpt-5.6-luna", reasoningEffort="max")
        response = self.client.post("/ask", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider.requests[-1].reasoning_effort, "max")

    def test_provider_state_round_trips_only_as_tool_metadata(self) -> None:
        state = self._provider_state()
        for endpoint in ("/ask", "/ask/stream"):
            with self.subTest(endpoint=endpoint):
                self.provider.answer = ChatCompletion(content=None, tool_calls=(ChatToolCall(
                    id="call-1", name="read_file", arguments='{"path":"app.py"}', provider_state=state,
                ),))
                payload = self._ask_payload(scope_type="project", items=[])
                payload["settings"].update(api="responses", model="gpt-5.6-luna")
                response = self.client.post(endpoint, json=payload)
                self.assertEqual(response.status_code, 200)
                if endpoint.endswith("stream"):
                    events = [json.loads(line) for line in response.iter_lines() if line]
                    data = events[-1]["result"]["data"]
                    self.assertNotIn("opaque-state-marker", json.dumps(events[:-1]))
                else:
                    data = response.json()["data"]
                self.assertEqual(data["answer"], "")
                self.assertEqual(data["toolCalls"][0]["providerState"], state)

                self.provider.answer = "Finished reading the file."
                payload["forceFinalAnswer"] = True
                payload["toolHistory"] = [{
                    "callId": "call-1", "name": "read_file", "arguments": {"path": "app.py"},
                    "result": "print('hello')", "providerState": data["toolCalls"][0]["providerState"],
                }]
                response = self.client.post(endpoint, json=payload)
                self.assertEqual(response.status_code, 200)
                messages = self.provider.requests[-1].messages
                self.assertEqual(messages[-2].provider_state, state)
                self.assertIsNone(messages[-1].provider_state)
                self.assertNotIn("opaque-state-marker", "\n".join(message.content or "" for message in messages))
                self.assertNotIn("opaque-state-marker", response.text)

    def test_provider_state_rejects_unapproved_content_without_echoing_it(self) -> None:
        valid = self._provider_state()
        invalid = []

        def changed(update):
            state = copy.deepcopy(valid)
            update(state)
            invalid.append(state)

        changed(lambda state: state.update(instructions="opaque-state-marker"))
        changed(lambda state: state.update(model=" "))
        changed(lambda state: state.update(endpoint="e" * 2_049))
        changed(lambda state: state.update(model="m" * 121))
        changed(lambda state: state["outputItems"][0].update(summary=[{"text": "opaque-state-marker"}]))
        changed(lambda state: state["outputItems"][0].update(content="opaque-state-marker"))
        changed(lambda state: state["outputItems"][0].update(encrypted_content="e" * 1_000_001))
        changed(lambda state: state["outputItems"][0].update(id="i" * 201))
        changed(lambda state: state["outputItems"][1].update(role="system"))
        changed(lambda state: state["outputItems"][1].update(phase="reasoning"))
        changed(lambda state: state["outputItems"][1]["content"][0].update(annotations=[{"text": "opaque-state-marker"}]))
        changed(lambda state: state["outputItems"][1]["content"][0].update(type="input_text"))
        changed(lambda state: state["outputItems"][1]["content"][0].update(text="t" * 400_001))
        changed(lambda state: state["outputItems"][1]["content"][0].update(text="\U0001f600" * 200_001))
        changed(lambda state: state["outputItems"][1].update(content=state["outputItems"][1]["content"] * 9))
        changed(lambda state: state["outputItems"][2].update(name="n" * 121))
        changed(lambda state: state["outputItems"][2].update(call_id="c" * 121))
        changed(lambda state: state["outputItems"][2].update(arguments="a" * 1_200_001))
        changed(lambda state: state["outputItems"][2].update(type="computer_call"))
        changed(lambda state: state.update(outputItems=[state["outputItems"][0]] * 17))
        changed(lambda state: state["outputItems"][0].update(encrypted_content=None))
        changed(lambda state: state.update(outputItems="opaque-state-marker"))
        invalid.extend(["opaque-state-marker", [], {"endpoint": "opaque-state-marker"}])

        with self.assertLogs("backend.app.main", level="WARNING") as logs:
            for state in invalid:
                payload = self._ask_payload(scope_type="project", items=[])
                payload["toolHistory"] = [{
                    "callId": "call-1", "name": "read_file", "arguments": {},
                    "result": "File contents", "providerState": state,
                }]
                response = self.client.post("/ask", json=payload)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("opaque-state-marker", response.text)
        self.assertNotIn("opaque-state-marker", "\n".join(logs.output))
        self.assertEqual(self.provider.requests, [])

    def test_provider_state_preserves_empty_content_and_optional_ids(self) -> None:
        state = self._provider_state()
        state["outputItems"][1].pop("id")
        state["outputItems"][1]["phase"] = "final_answer"
        state["outputItems"][1]["content"][0]["text"] = ""
        state["outputItems"][2].pop("id")
        state["outputItems"][2]["arguments"] = ""
        payload = self._ask_payload(scope_type="project", items=[])
        payload["toolHistory"] = [{
            "callId": "call-1", "name": "read_file", "arguments": {},
            "result": "File contents", "providerState": state,
        }]
        response = self.client.post("/ask", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider.requests[-1].messages[-2].provider_state, state)

    def test_provider_state_enforces_per_state_and_whole_history_limits(self) -> None:
        state = self._provider_state()
        item = state["outputItems"][0]
        item["encrypted_content"] = "e" * 850_000
        state["outputItems"] = [item, {**item, "id": "reasoning-2"}]
        payload = self._ask_payload(scope_type="project", items=[])
        payload["forceFinalAnswer"] = True
        payload["toolHistory"] = [{
            "callId": f"call-{index}", "name": "read_file", "arguments": {},
            "result": "File contents", "providerState": state,
        } for index in range(4)]
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 200)
        payload["toolHistory"].append({**payload["toolHistory"][0], "callId": "call-4"})
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

        state["outputItems"].append({**item, "id": "reasoning-3"})
        payload["toolHistory"] = [payload["toolHistory"][0]]
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_invalid_state_from_provider_returns_a_bounded_error(self) -> None:
        state = self._provider_state()
        state["outputItems"][0]["summary"] = [{"text": "opaque-state-marker"}]
        self.provider.answer = ChatCompletion(content=None, tool_calls=(ChatToolCall(
            id="call-1", name="read_file", arguments="{}", provider_state=state,
        ),))
        response = self.client.post("/ask", json=self._ask_payload(scope_type="project", items=[]))
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "The model returned invalid provider state."})

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
        self.assertEqual(len(self.provider.requests[-1].tools), len(READ_ONLY_AGENT_TOOLS))
        self.assertEqual(
            [tool.name for tool in self.provider.requests[-1].tools],
            [
                "get_project_info", "get_git_changes",
                "list_files", "read_file", "search_code",
                "get_symbols", "find_definition", "find_references",
                "get_diagnostics", "read_terminal_errors",
            ],
        )
        self.assertGreater(data["tokenUsage"]["inputTokens"], 0)

    def test_ask_prefers_provider_reported_token_usage(self) -> None:
        self.provider.answer = ChatCompletion(
            content="Exact usage answer",
            usage=ChatTokenUsage(
                input_tokens=123,
                output_tokens=17,
                total_tokens=140,
            ),
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["tokenUsage"], {
            "inputTokens": 123,
            "outputTokens": 17,
            "totalTokens": 140,
            "exact": True,
        })

    def test_ask_converts_textual_tool_markup_into_a_validated_call(self) -> None:
        self.provider.answer = ChatCompletion(
            content=(
                "<tool_call>\n<function=read_file>\n"
                "<parameter=endLine>1950</parameter>\n"
                "<parameter=path>styles.css</parameter>\n"
                "<parameter=startLine>1</parameter>\n"
                "</function>\n</tool_call>"
            )
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["answer"], "")
        self.assertEqual(len(data["toolCalls"]), 1)
        self.assertEqual(data["toolCalls"][0]["name"], "read_file")
        self.assertEqual(data["toolCalls"][0]["arguments"], {
            "endLine": 1950,
            "path": "styles.css",
            "startLine": 1,
        })

    def test_stream_hides_textual_tool_markup_and_returns_the_call(self) -> None:
        content = (
            "<tool_call>\n<function=read_file>\n"
            "<parameter=path>styles.css</parameter>\n"
            "</function>\n</tool_call>"
        )

        async def stream(request: ChatCompletionRequest):
            self.provider.requests.append(request)
            yield ChatStreamEvent(kind="content", text="<tool_")
            yield ChatStreamEvent(kind="content", text=content[len("<tool_"):])
            yield ChatStreamEvent(
                kind="complete",
                completion=ChatCompletion(content=content),
            )

        self.provider.stream = stream
        try:
            with self.client.stream(
                "POST",
                "/ask/stream",
                json=self._ask_payload(scope_type="project", items=[]),
            ) as response:
                events = [json.loads(line) for line in response.iter_lines() if line]
        finally:
            del self.provider.stream

        self.assertEqual(response.status_code, 200)
        self.assertFalse(any(event.get("type") == "delta" for event in events))
        self.assertTrue(any(
            event.get("type") == "progress"
            and event.get("phase") == "Preparing project tool call"
            for event in events
        ))
        self.assertEqual(events[-1]["type"], "final")
        self.assertEqual(events[-1]["result"]["data"]["toolCalls"][0]["name"], "read_file")

    def test_ask_rejects_malformed_textual_tool_markup(self) -> None:
        self.provider.answer = ChatCompletion(
            content="<tool_call><function=read_file><parameter=path>styles.css</function></tool_call>"
        )

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.json(),
            {"detail": "The model returned a malformed textual tool call."},
        )

    def test_ask_returns_manifest_dependency_install_tool_calls(self) -> None:
        self.provider.answer = ChatCompletion(
            content=None,
            tool_calls=(
                ChatToolCall(
                    id="install-1",
                    name="install_dependencies",
                    arguments='{"manifestPath":"requirements.txt","timeoutSeconds":600}',
                ),
            ),
        )
        payload = self._ask_payload(scope_type="project", items=[], mode="code")
        payload["enabledTools"] = ["install_dependencies"]
        payload["agentEditsEnabled"] = True

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["toolCalls"], [{
            "id": "install-1",
            "name": "install_dependencies",
            "arguments": {
                "manifestPath": "requirements.txt",
                "timeoutSeconds": 600,
            },
        }])

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
        self.assertIn("human-readable summary", provider_request.messages[0].content)
        self.assertIn("Do not emit tool-call markup", provider_request.messages[0].content)
        self.assertEqual(provider_request.messages[-2].role, "assistant")
        self.assertEqual(provider_request.messages[-2].tool_calls[0].id, "call-1")
        self.assertEqual(provider_request.messages[-1].role, "tool")
        self.assertIn("answer = 42", provider_request.messages[-1].content)

    def test_reasoning_recovery_keeps_requested_tools_available(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[], mode="code")
        payload["enabledTools"] = ["read_file", "edit_file"]
        payload["agentEditsEnabled"] = True
        payload["disableThinking"] = True

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        provider_request = self.provider.requests[-1]
        self.assertTrue(provider_request.disable_thinking)
        self.assertFalse(provider_request.force_final_answer)
        self.assertEqual([tool.name for tool in provider_request.tools], ["read_file", "edit_file"])
        self.assertIn("Thinking is disabled for recovery", provider_request.messages[0].content)

    def test_read_only_code_agent_accepts_plain_answers_without_file_proposals(self) -> None:
        for endpoint in ("/ask", "/ask/stream"):
            with self.subTest(endpoint=endpoint):
                payload = self._ask_payload(scope_type="project", items=[], mode="code")
                payload["enabledTools"] = []
                payload["agentEditsEnabled"] = True
                self.provider.answer = "The selected configuration permits explanation only."
                response = self.client.post(endpoint, json=payload)
                self.assertEqual(response.status_code, 200)
                result = response.json() if endpoint == "/ask" else next(
                    json.loads(line)["result"] for line in response.text.splitlines()
                    if json.loads(line)["type"] == "final"
                )
                self.assertEqual(result["data"]["answer"], self.provider.answer)
                self.assertEqual(result["data"]["changes"], [])
                self.assertEqual(self.provider.requests[-1].tools, ())

    def test_forced_code_summary_never_parses_legacy_file_proposals(self) -> None:
        answers = (
            "The completed changes have been verified.",
            '{"summary":"Done","changes":[{"path":"extra.ts","content":"unexpected edit"}]}',
        )
        for endpoint in ("/ask", "/ask/stream"):
            for answer in answers:
                with self.subTest(endpoint=endpoint, answer=answer):
                    payload = self._ask_payload(scope_type="project", items=[], mode="code")
                    payload["enabledTools"] = []
                    payload["forceFinalAnswer"] = True
                    payload["agentEditsEnabled"] = False  # Older clients still need safe summary behavior.
                    self.provider.answer = answer
                    response = self.client.post(endpoint, json=payload)
                    self.assertEqual(response.status_code, 200)
                    result = response.json() if endpoint == "/ask" else next(
                        json.loads(line)["result"] for line in response.text.splitlines()
                        if json.loads(line)["type"] == "final"
                    )
                    self.assertEqual(result["data"]["answer"], answer)
                    self.assertEqual(result["data"]["changes"], [])
                    self.assertEqual(result["data"]["toolCalls"], [])
                    self.assertNotIn("Return only one JSON object", self.provider.requests[-1].messages[0].content)

    def test_ask_accepts_the_configurable_tool_history_ceiling(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["forceFinalAnswer"] = True
        payload["toolHistory"] = [
            {
                "callId": f"call-{index}",
                "name": "list_files",
                "arguments": {"path": ""},
                "result": "No eligible files.",
                "isError": False,
            }
            for index in range(MAX_AGENT_TOOL_STEPS)
        ]

        self.assertEqual(self.client.post("/ask", json=payload).status_code, 200)
        payload["toolHistory"].append({
            "callId": "one-too-many",
            "name": "list_files",
            "arguments": {"path": ""},
            "result": "No eligible files.",
            "isError": False,
        })
        self.assertEqual(self.client.post("/ask", json=payload).status_code, 422)

    def test_validation_errors_identify_fields_without_echoing_request_input(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[])
        payload["toolHistory"] = [{
            "callId": "oversized",
            "name": "edit_file",
            "arguments": {"secretContent": "private-value-" * 400},
            "result": "Edit completed.",
            "isError": False,
        }]

        response = self.client.post("/ask/stream", json=payload)

        self.assertEqual(response.status_code, 422)
        body = response.json()
        self.assertIn("toolHistory", str(body["detail"][0]["loc"]))
        self.assertIn("tool arguments are too large", body["detail"][0]["msg"])
        self.assertNotIn("private-value", response.text)

    def test_ask_exposes_only_requested_mode_tools(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[], mode="debug")
        payload["enabledTools"] = [
            "read_file", "edit_file", "delete_file", "rename_file", "move_file",
            "install_dependencies", "run_command"
        ]
        payload["agentEditsEnabled"] = True

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [tool.name for tool in self.provider.requests[-1].tools],
            [
                "read_file", "edit_file", "delete_file", "rename_file", "move_file",
                "install_dependencies", "run_command"
            ],
        )
        self.assertIn("apply the smallest focused fix", self.provider.requests[-1].messages[0].content)

        ideas_payload = self._ask_payload(scope_type="project", items=[], mode="ideas")
        ideas_payload["enabledTools"] = [
            "read_file", "get_diagnostics", "read_terminal_errors",
            "edit_file", "install_dependencies", "run_command"
        ]
        response = self.client.post("/ask", json=ideas_payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [tool.name for tool in self.provider.requests[-1].tools],
            ["read_file", "get_diagnostics", "read_terminal_errors"],
        )

    def test_ask_replays_bounded_conversation_history(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[], mode="code")
        payload["agentEditsEnabled"] = True
        payload["conversationHistory"] = [
            {
                "user": "Create a unittest for app.py.",
                "assistant": "Created test_app.py, but pytest was unavailable.",
            }
        ]

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        messages = self.provider.requests[-1].messages
        self.assertEqual([message.role for message in messages[:4]], [
            "system", "user", "assistant", "user"
        ])
        self.assertIn("Create a unittest", messages[1].content)
        self.assertIn("pytest was unavailable", messages[2].content)

        payload["conversationHistory"] = [
            {"user": "u" * 6_000, "assistant": "a" * 6_000},
            {"user": "u" * 6_000, "assistant": "a" * 6_000},
        ]
        response = self.client.post("/ask", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_ask_accepts_six_conversation_turns_and_rejects_the_seventh(self) -> None:
        payload = self._ask_payload(scope_type="project", items=[], mode="debug")
        payload["conversationHistory"] = [
            {"user": f"Question {index}", "assistant": f"Answer {index}"}
            for index in range(6)
        ]

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        messages = self.provider.requests[-1].messages
        self.assertEqual(
            [message.content for message in messages[1:13:2]],
            [f"Question {index}" for index in range(6)],
        )
        self.assertEqual(
            [message.content for message in messages[2:14:2]],
            [f"Answer {index}" for index in range(6)],
        )

        payload["conversationHistory"].append({
            "user": "Question 6",
            "assistant": "Answer 6",
        })
        response = self.client.post("/ask", json=payload)
        self.assertEqual(response.status_code, 422)

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

    def test_agent_edit_code_mode_returns_normal_final_text(self) -> None:
        self.provider.answer = "Updated the implementation and npm test passed."
        payload = self._ask_payload(scope_type="project", items=[], mode="code")
        payload["enabledTools"] = ["create_file", "edit_file", "run_command"]
        payload["agentEditsEnabled"] = True

        response = self.client.post("/ask", json=payload)

        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["answer"], self.provider.answer)
        self.assertEqual(data["changes"], [])
        self.assertIn("Use create_file, edit_file, delete_file", self.provider.requests[-1].messages[0].content)
        self.assertIn("Never use run_command for mkdir, move, mv", self.provider.requests[-1].messages[0].content)
        self.assertIn("create missing destination directories automatically", self.provider.requests[-1].messages[0].content)

    @staticmethod
    def _provider_state() -> dict[str, object]:
        return {
            "endpoint": "https://api.openai.com/v1/responses",
            "model": "gpt-5.6-luna",
            "outputItems": [
                {"id": "reasoning-1", "type": "reasoning", "summary": [],
                 "encrypted_content": "opaque-state-marker"},
                {"id": "message-1", "type": "message", "role": "assistant", "phase": "commentary",
                 "content": [{"type": "output_text", "text": "Reading app.py.", "annotations": []}]},
                {"id": "function-1", "type": "function_call", "call_id": "call-1", "name": "read_file",
                 "arguments": '{"path":"app.py"}'},
            ],
        }

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
