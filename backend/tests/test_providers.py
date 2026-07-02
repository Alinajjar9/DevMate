import json
import unittest

import httpx

from backend.app.providers import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatMessage,
    ChatToolCall,
    ChatToolDefinition,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    OpenAICompatibleProvider,
    ProviderError,
    create_chat_completions_url,
    parse_provider_timeout_seconds,
)


class ProviderUrlTests(unittest.TestCase):
    def test_provider_timeout_defaults_to_fifteen_minutes(self) -> None:
        self.assertEqual(DEFAULT_PROVIDER_TIMEOUT_SECONDS, 900.0)
        self.assertEqual(
            parse_provider_timeout_seconds(None),
            DEFAULT_PROVIDER_TIMEOUT_SECONDS,
        )

    def test_provider_timeout_accepts_safe_environment_override(self) -> None:
        self.assertEqual(parse_provider_timeout_seconds("600"), 600.0)
        for value in ("invalid", "9", "1801"):
            with self.subTest(value=value):
                self.assertEqual(
                    parse_provider_timeout_seconds(value),
                    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
                )

    def test_builds_nvidia_chat_completions_url(self) -> None:
        self.assertEqual(
            create_chat_completions_url(
                "https://integrate.api.nvidia.com/v1",
                "openai",
            ),
            "https://integrate.api.nvidia.com/v1/chat/completions",
        )

    def test_adds_v1_to_an_ollama_server_root(self) -> None:
        self.assertEqual(
            create_chat_completions_url("http://127.0.0.1:11434", "ollama"),
            "http://127.0.0.1:11434/v1/chat/completions",
        )

    def test_rejects_embedded_credentials_and_query_parameters(self) -> None:
        for base_url in (
            "https://user:password@example.com/v1",
            "https://example.com/v1?token=secret",
        ):
            with self.subTest(base_url=base_url):
                with self.assertRaises(ProviderError) as caught:
                    create_chat_completions_url(base_url, "openai")
                self.assertEqual(caught.exception.status_code, 400)


class OpenAICompatibleProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_streams_content_without_exposing_reasoning_text(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertTrue(payload["stream"])
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=(
                    'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n'
                    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n'
                    'data: [DONE]\n\n'
                ),
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        events = [event async for event in provider.stream(self._request())]

        self.assertEqual([event.kind for event in events], [
            "reasoning", "content", "content", "complete"
        ])
        self.assertIsNone(events[0].text)
        self.assertEqual(events[-1].completion.content, "Hello world")
        self.assertEqual(events[-1].completion.reasoning_content, "private")
        self.assertEqual(events[-1].completion.finish_reason, "stop")
        self.assertEqual(events[-1].completion.usage.input_tokens, 12)
        self.assertEqual(events[-1].completion.usage.output_tokens, 3)
        self.assertEqual(events[-1].completion.usage.total_tokens, 15)

    async def test_reassembles_streamed_tool_call_arguments(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n'
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"app.py\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
                    'data: [DONE]\n\n'
                ),
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        events = [event async for event in provider.stream(self._request())]
        completion = events[-1].completion

        self.assertEqual([event.kind for event in events], ["tool", "complete"])
        self.assertEqual(completion.tool_calls[0].id, "call-1")
        self.assertEqual(completion.tool_calls[0].name, "read_file")
        self.assertEqual(completion.tool_calls[0].arguments, '{"path":"app.py"}')

    async def test_sends_nvidia_compatible_request_and_reads_answer(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(
                str(request.url),
                "https://integrate.api.nvidia.com/v1/chat/completions",
            )
            self.assertEqual(request.headers["Authorization"], "Bearer secret-key")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "nvidia/example-model")
            self.assertEqual(payload["max_tokens"], 1200)
            self.assertNotIn("max_completion_tokens", payload)
            self.assertEqual(payload["messages"][0]["role"], "system")
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"role": "assistant", "content": "Real answer"}}
                    ]
                },
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))

        completion = await provider.complete(self._request())

        self.assertEqual(completion, ChatCompletion(content="Real answer"))

    async def test_uses_current_openai_token_parameter_for_default_endpoint(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(str(request.url), "https://api.openai.com/v1/chat/completions")
            self.assertEqual(payload["max_completion_tokens"], 1200)
            self.assertNotIn("max_tokens", payload)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "OpenAI answer"}}]},
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        request = self._request(base_url=None)

        self.assertEqual(
            await provider.complete(request),
            ChatCompletion(content="OpenAI answer"),
        )

    async def test_sends_supported_openai_reasoning_effort(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(payload["reasoning_effort"], "xhigh")
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Reasoned answer"}}]},
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        completion = await provider.complete(self._request(
            base_url=None,
            model="gpt-5.4-nano",
            reasoning_effort="xhigh",
        ))

        self.assertEqual(completion.content, "Reasoned answer")

    async def test_does_not_send_reasoning_effort_to_unknown_compatible_endpoints(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertNotIn("reasoning_effort", payload)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Compatible answer"}}]},
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        completion = await provider.complete(self._request(
            model="vendor/reasoning-model",
            reasoning_effort="high",
        ))

        self.assertEqual(completion.content, "Compatible answer")

    async def test_maps_nemotron_intelligence_to_supported_controls(self) -> None:
        expected = {
            "low": ({"enable_thinking": True, "force_nonempty_content": True}, 300),
            "medium": ({
                "enable_thinking": True,
                "force_nonempty_content": True,
                "medium_effort": True,
            }, None),
            "high": ({"enable_thinking": True, "force_nonempty_content": True}, None),
        }
        for effort, (template_kwargs, budget) in expected.items():
            async def handler(request: httpx.Request) -> httpx.Response:
                payload = json.loads(request.content)
                self.assertEqual(payload["chat_template_kwargs"], template_kwargs)
                if budget is None:
                    self.assertNotIn("reasoning_budget", payload)
                else:
                    self.assertEqual(payload["reasoning_budget"], budget)
                return httpx.Response(
                    200,
                    json={"choices": [{"message": {"content": "Nemotron answer"}}]},
                )

            with self.subTest(effort=effort):
                provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                completion = await provider.complete(self._request(
                    model="nvidia/nemotron-3-ultra-550b-a55b",
                    reasoning_effort=effort,
                ))
                self.assertEqual(completion.content, "Nemotron answer")

    async def test_uses_the_request_specific_provider_timeout(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.extensions["timeout"]["read"], 1_200)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Slow answer"}}]},
            )

        provider = OpenAICompatibleProvider(
            transport=httpx.MockTransport(handler),
            timeout_seconds=30,
        )

        completion = await provider.complete(
            self._request(timeout_seconds=1_200)
        )

        self.assertEqual(completion.content, "Slow answer")

    async def test_sends_tools_and_reads_function_calls(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(payload["tool_choice"], "auto")
            self.assertEqual(payload["tools"][0]["function"]["name"], "read_file")
            self.assertEqual(
                payload["chat_template_kwargs"],
                {"enable_thinking": True, "force_nonempty_content": True},
            )
            self.assertEqual(payload["reasoning_budget"], 600)
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "type": "function",
                                        "function": {
                                            "name": "read_file",
                                            "arguments": '{"path":"src/app.ts"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                },
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        request = self._request(
            model="nvidia/nemotron-3-ultra-550b-a55b",
            tools=(
                ChatToolDefinition(
                    name="read_file",
                    description="Read one file.",
                    parameters={"type": "object"},
                ),
            )
        )

        completion = await provider.complete(request)

        self.assertIsNone(completion.content)
        self.assertEqual(completion.tool_calls[0].name, "read_file")
        self.assertEqual(completion.tool_calls[0].arguments, '{"path":"src/app.ts"}')

    async def test_disables_nemotron_reasoning_for_a_forced_final_answer(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(
                payload["chat_template_kwargs"],
                {"enable_thinking": False, "force_nonempty_content": True},
            )
            self.assertNotIn("reasoning_budget", payload)
            self.assertNotIn("tools", payload)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Concise final answer"}}]},
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))

        completion = await provider.complete(
            self._request(
                model="nvidia/nemotron-3-ultra-550b-a55b",
                force_final_answer=True,
            )
        )

        self.assertEqual(completion.content, "Concise final answer")

    async def test_disables_nemotron_reasoning_without_removing_tools(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(
                payload["chat_template_kwargs"],
                {"enable_thinking": False, "force_nonempty_content": True},
            )
            self.assertNotIn("reasoning_budget", payload)
            self.assertEqual(payload["tools"][0]["function"]["name"], "read_file")
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Recovered answer"}}]},
            )

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        completion = await provider.complete(
            self._request(
                model="nvidia/nemotron-3-ultra-550b-a55b",
                disable_thinking=True,
                tools=(ChatToolDefinition(
                    name="read_file",
                    description="Read one file.",
                    parameters={"type": "object"},
                ),),
            )
        )

        self.assertEqual(completion.content, "Recovered answer")

    async def test_preserves_reasoning_only_completion_metadata(self) -> None:
        provider = OpenAICompatibleProvider(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "choices": [
                            {
                                "finish_reason": "length",
                                "message": {
                                    "content": None,
                                    "reasoning_content": "Internal reasoning only",
                                },
                            }
                        ]
                    },
                )
            )
        )

        completion = await provider.complete(self._request())

        self.assertIsNone(completion.content)
        self.assertEqual(completion.finish_reason, "length")
        self.assertEqual(completion.reasoning_content, "Internal reasoning only")

    async def test_serializes_assistant_tool_calls_and_tool_results(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            self.assertEqual(payload["messages"][-2]["role"], "assistant")
            self.assertEqual(payload["messages"][-2]["tool_calls"][0]["id"], "call-1")
            self.assertEqual(payload["messages"][-1]["role"], "tool")
            self.assertEqual(payload["messages"][-1]["tool_call_id"], "call-1")
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Final answer"}}]},
            )

        messages = (
            ChatMessage(role="system", content="System guidance"),
            ChatMessage(role="user", content="Inspect the app"),
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=(
                    ChatToolCall(
                        id="call-1",
                        name="read_file",
                        arguments='{"path":"src/app.ts"}',
                    ),
                ),
            ),
            ChatMessage(
                role="tool",
                content="export const app = true;",
                tool_call_id="call-1",
            ),
        )
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))

        completion = await provider.complete(self._request(messages=messages))

        self.assertEqual(completion.content, "Final answer")

    async def test_maps_authentication_and_rate_limit_errors(self) -> None:
        for status_code, expected_status in ((401, 401), (429, 429)):
            with self.subTest(status_code=status_code):
                transport = httpx.MockTransport(
                    lambda request: httpx.Response(
                        status_code,
                        json={"error": {"message": "Provider rejected this request"}},
                    )
                )
                provider = OpenAICompatibleProvider(transport=transport)

                with self.assertRaises(ProviderError) as caught:
                    await provider.complete(self._request())

                self.assertEqual(caught.exception.status_code, expected_status)
                self.assertEqual(str(caught.exception), "Provider rejected this request")

    async def test_maps_timeouts_without_leaking_request_details(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))

        with self.assertRaises(ProviderError) as caught:
            await provider.complete(self._request())

        self.assertEqual(caught.exception.status_code, 504)
        self.assertEqual(
            str(caught.exception),
            "The model provider timed out before returning an answer.",
        )

    async def test_requires_a_key_for_openai_compatible_profiles(self) -> None:
        provider = OpenAICompatibleProvider(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(500)
            )
        )

        with self.assertRaises(ProviderError) as caught:
            await provider.complete(self._request(api_key=None))

        self.assertEqual(caught.exception.status_code, 400)

    @staticmethod
    def _request(
        *,
        base_url: str | None = "https://integrate.api.nvidia.com/v1",
        api_key: str | None = "secret-key",
        model: str = "nvidia/example-model",
        tools: tuple[ChatToolDefinition, ...] = (),
        messages: tuple[ChatMessage, ...] | None = None,
        force_final_answer: bool = False,
        disable_thinking: bool = False,
        reasoning_effort: str = "auto",
        timeout_seconds: float | None = None,
    ) -> ChatCompletionRequest:
        return ChatCompletionRequest(
            provider="openai",
            model=model,
            base_url=base_url,
            api_key=api_key,
            messages=messages or (
                ChatMessage(role="system", content="System guidance"),
                ChatMessage(role="user", content="Hello"),
            ),
            max_tokens=1200,
            temperature=0.2,
            reasoning_effort=reasoning_effort,
            timeout_seconds=timeout_seconds,
            tools=tools,
            force_final_answer=force_final_answer,
            disable_thinking=disable_thinking,
        )


if __name__ == "__main__":
    unittest.main()
