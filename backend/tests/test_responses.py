import copy
import json
import unittest
from dataclasses import replace

import httpx

from backend.app.providers import (
    ChatCompletionRequest, ChatMessage, ChatToolCall, ChatToolDefinition,
    OpenAICompatibleProvider, ProviderError, create_provider_url,
)


def request_for(**overrides):
    return replace(ChatCompletionRequest(
        provider="openai", model="gpt-5.6-luna", base_url=None, api_key="test-key",
        messages=(ChatMessage("user", "Read app.py"),), max_tokens=1200, temperature=0.2,
        tools=(ChatToolDefinition("read_file", "Read a file", {"type": "object", "properties": {
            "path": {"type": "string"}}, "required": []}),),
    ), **overrides)


def tool_response():
    return {"status": "completed", "output": [
        {"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "opaque-context"},
        {"id": "msg_1", "type": "message", "role": "assistant", "phase": "commentary",
         "content": [{"type": "output_text", "text": "Reading app.py.", "annotations": []}]},
        {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "read_file",
         "arguments": '{"path":"app.py"}', "status": "completed"},
    ], "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}}


def final_response():
    return {"status": "completed", "output": [{"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "It works.", "annotations": []}]}]}


def sse(*events):
    return httpx.Response(200, headers={"content-type": "text/event-stream"},
                          content="".join(f"data: {json.dumps(event)}\n\n" for event in events))


class ResponsesTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_routes_openai_models_without_a_model_allowlist(self):
        for model in ("gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "o3", "gpt-4.1", "future-model"):
            for effort in ("auto", "none", "high", "max"):
                for stream in (False, True):
                    with self.subTest(model=model, effort=effort, stream=stream):
                        def handler(request):
                            payload = json.loads(request.content)
                            self.assertEqual(str(request.url), "https://api.openai.com/v1/responses")
                            self.assertEqual(payload["max_output_tokens"], 1200)
                            self.assertFalse(payload["store"])
                            self.assertTrue(payload["tools"][0]["strict"])
                            self.assertFalse(payload["parallel_tool_calls"])
                            self.assertNotIn("reasoning_effort", payload)
                            if effort == "auto":
                                self.assertNotIn("reasoning", payload)
                            else:
                                self.assertEqual(payload["reasoning"], {"effort": effort})
                            return httpx.Response(200, json=tool_response())
                        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                        request = request_for(model=model, reasoning_effort=effort)
                        completion = (await self.collect(provider, request)) if stream else await provider.complete(request)
                        self.assertEqual(completion.tool_calls[0].name, "read_file")
                        self.assertEqual(completion.usage.total_tokens, 120)

    async def test_replays_original_output_with_encrypted_reasoning_and_assistant_phase(self):
        requests = []
        def handler(request):
            payload = json.loads(request.content)
            requests.append(payload)
            return httpx.Response(200, json=tool_response() if len(requests) == 1 else final_response())
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        request = request_for(reasoning_effort="high")
        completion = await provider.complete(request)
        call = completion.tool_calls[0]
        state = call.provider_state
        self.assertEqual(state["outputItems"][0]["encrypted_content"], "opaque-context")
        # The visible argument summary is deliberately different. Replay must use original model items.
        followup = replace(request, tools=(), force_final_answer=True, disable_thinking=True, messages=(
            *request.messages,
            ChatMessage("assistant", None, (ChatToolCall(call.id, call.name, '{"summary":"compacted"}'),),
                        provider_state=state),
            ChatMessage("tool", "File contents", tool_call_id=call.id),
        ))
        final = await self.collect(provider, followup)
        self.assertEqual(final.content, "It works.")
        self.assertEqual(requests[1]["input"][1:4], state["outputItems"])
        self.assertEqual(requests[1]["input"][-1], {"type": "function_call_output", "call_id": "call_1", "output": "File contents"})
        self.assertEqual(requests[1]["reasoning"], {"effort": "high"})
        self.assertNotIn("tools", requests[1])

    async def test_stream_uses_terminal_items_not_partial_reasoning_or_arguments(self):
        def handler(request):
            return sse(
                {"type": "response.output_item.added", "item": {"type": "reasoning", "encrypted_content": "partial"}},
                {"type": "response.reasoning_text.delta", "delta": "private reasoning"},
                {"type": "response.output_text.delta", "delta": "Reading app.py."},
                {"type": "response.output_item.added", "item": {"type": "function_call"}},
                {"type": "response.function_call_arguments.delta", "delta": "{broken"},
                {"type": "response.completed", "response": tool_response()},
            )
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        events = [event async for event in provider.stream(request_for())]
        self.assertEqual([event.kind for event in events], ["reasoning", "content", "tool", "complete"])
        self.assertIsNone(events[0].text)
        self.assertIsNone(events[-1].completion.reasoning_content)
        self.assertEqual(events[-1].completion.tool_calls[0].arguments, '{"path":"app.py"}')
        self.assertEqual(events[-1].completion.tool_calls[0].provider_state["outputItems"][0]["encrypted_content"], "opaque-context")

    async def test_truncated_failed_or_incomplete_stream_never_returns_executable_tools(self):
        for tail in (None, {"type": "error", "message": "Stream failed"},
                     {"type": "response.incomplete", "response": {**tool_response(), "status": "incomplete"}}):
            with self.subTest(tail=tail):
                calls = []
                def handler(request):
                    calls.append(request)
                    events = [{"type": "response.output_item.added", "item": tool_response()["output"][-1]}]
                    return sse(*events, *([tail] if tail else []))
                provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                with self.assertRaises(ProviderError):
                    await self.collect(provider, request_for())
                self.assertEqual(len(calls), 1)

    async def test_incomplete_reasoning_only_output_preserves_token_limit_metadata(self):
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
            "status": "incomplete", "output": [], "usage": {"input_tokens": 10, "output_tokens": 1200},
        })))
        result = await provider.complete(request_for())
        self.assertEqual(result.finish_reason, "length")
        self.assertFalse(result.tool_calls)
        self.assertEqual(result.usage.total_tokens, 1210)

    async def test_invalid_tool_context_is_rejected_before_execution(self):
        bad_outputs = []
        for patch in ({"call_id": ""}, {"name": "x" * 121}, {"arguments": None}, {"arguments": "x" * 1_200_001}):
            result = tool_response()
            result["output"][-1].update(patch)
            bad_outputs.append(result)
        missing_reasoning = tool_response()
        missing_reasoning["output"][0].pop("encrypted_content")
        bad_outputs.append(missing_reasoning)
        parallel = tool_response()
        parallel["output"].append(copy.deepcopy(parallel["output"][-1]))
        bad_outputs.append(parallel)
        for result in bad_outputs:
            provider = OpenAICompatibleProvider(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=result)))
            with self.assertRaises(ProviderError):
                await provider.complete(request_for())

    async def test_reasoning_context_is_not_sent_to_another_endpoint_or_model(self):
        state = {"endpoint": "https://api.openai.com/v1/responses", "model": "original-model", "outputItems": tool_response()["output"][:1]}
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, json=final_response())
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        messages = (ChatMessage("assistant", None, (ChatToolCall("call_1", "read_file", "{}"),), provider_state=state),)
        for model, base_url in (("different-model", None), ("original-model", "https://other.example/v1")):
            await provider.complete(request_for(api="responses", messages=messages, model=model, base_url=base_url))
        self.assertTrue(all("opaque-context" not in json.dumps(payload) for payload in captured))

    async def test_endpoint_api_selection_preserves_custom_and_ollama_profiles(self):
        for provider_name, api, base_url, suffix in (
            ("openai", "auto", "https://custom.example/v1", "chat/completions"),
            ("ollama", "auto", "http://localhost:11434", "chat/completions"),
            ("openai", "responses", "https://custom.example/v1/chat/completions", "responses"),
            ("openai", "auto", "https://custom.example/v1/responses", "responses"),
            ("openai", "chat_completions", None, "chat/completions"),
        ):
            with self.subTest(provider=provider_name, api=api, base_url=base_url):
                def handler(request):
                    payload = json.loads(request.content)
                    self.assertTrue(str(request.url).endswith("/v1/" + suffix))
                    self.assertEqual(payload["reasoning"]["effort"] if suffix == "responses" else payload["reasoning_effort"], "high")
                    return httpx.Response(200, json=final_response() if suffix == "responses" else {"choices": [{"message": {"content": "Answer"}}]})
                provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                await provider.complete(request_for(provider=provider_name, api=api, base_url=base_url, reasoning_effort="high"))

    async def test_auto_adapts_explicit_api_and_temperature_rejections_without_disabling_reasoning(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                sent = []
                def handler(request):
                    payload = json.loads(request.content)
                    sent.append((str(request.url), payload))
                    if str(request.url).endswith("/chat/completions"):
                        return httpx.Response(400, json={"error": {"message": "Function tools with reasoning require /v1/responses."}})
                    if "temperature" in payload:
                        return httpx.Response(400, json={"error": {"message": "Unsupported parameter: 'temperature'."}})
                    return httpx.Response(200, json=tool_response())
                provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                request = request_for(base_url="https://gateway.example/v1", reasoning_effort="high")
                result = await self.collect(provider, request) if stream else await provider.complete(request)
                self.assertEqual(len(sent), 3)
                self.assertEqual(sent[-1][1]["reasoning"], {"effort": "high"})
                self.assertTrue(sent[-1][1]["tools"])
                self.assertEqual(result.tool_calls[0].provider_state["endpoint"], "https://gateway.example/v1/responses")
                # Subsequent Auto turns remember the successful API from the completed tool context.
                sent.clear()
                call = result.tool_calls[0]
                await provider.complete(replace(request, messages=(
                    ChatMessage("assistant", None, (call,), provider_state=call.provider_state),
                    ChatMessage("tool", "result", tool_call_id=call.id),
                )))
                self.assertTrue(all(url.endswith("/responses") for url, _ in sent))

    async def test_unsupported_reasoning_and_explicit_api_errors_are_not_silently_retried(self):
        for api, message in (("auto", "Unsupported parameter: reasoning.effort"),
                             ("chat_completions", "Function tools with reasoning require /v1/responses.")):
            sent = []
            def handler(request):
                sent.append(request)
                return httpx.Response(400, json={"error": {"message": message}})
            provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
            with self.assertRaises(ProviderError) as caught:
                await self.collect(provider, request_for(api=api, reasoning_effort="high"))
            self.assertEqual(caught.exception.status_code, 400)
            self.assertEqual(len(sent), 1)

    async def test_api_switch_keeps_a_previously_rejected_temperature_omitted(self):
        for stream in (False, True):
            sent = []
            def handler(request):
                payload = json.loads(request.content)
                sent.append(payload)
                if "temperature" in payload:
                    return httpx.Response(400, json={"error": {"message": "Unsupported parameter: temperature"}})
                if str(request.url).endswith("/chat/completions"):
                    return httpx.Response(400, json={"error": {"message": "Reasoning tools require /v1/responses"}})
                self.assertEqual(payload["reasoning"], {"effort": "high"})
                return httpx.Response(200, json=tool_response())
            provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
            request = request_for(base_url="https://gateway.example/v1", reasoning_effort="high")
            result = await self.collect(provider, request) if stream else await provider.complete(request)
            self.assertEqual(len(sent), 3)
            self.assertTrue(result.tool_calls)
            self.assertNotIn("temperature", sent[-1])

    async def test_mismatched_tool_context_is_not_replayed(self):
        state = {"endpoint": "https://api.openai.com/v1/responses", "model": "gpt-5.6-luna",
                 "outputItems": [{**tool_response()["output"][-1]}]}
        state["outputItems"][0].pop("status")
        def handler(request):
            self.fail("Mismatched state must be rejected before sending")
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        for call in (ChatToolCall("other_id", "read_file", "{}"), ChatToolCall("call_1", "write_file", "{}")):
            with self.assertRaisesRegex(ProviderError, "does not match"):
                await provider.complete(request_for(messages=(ChatMessage("assistant", None, (call,), provider_state=state),)))

    def test_replaces_full_api_suffixes_and_rejects_invalid_urls(self):
        self.assertEqual(create_provider_url("https://api.openai.com/v1/chat/completions/", "openai", "responses"), "https://api.openai.com/v1/responses")
        for url in ("https://user:pass@api.openai.com/v1", "https://api.openai.com/v1?key=secret", "https://api.openai.com:bad/v1"):
            with self.assertRaises(ProviderError):
                create_provider_url(url, "openai", "responses")

    @staticmethod
    async def collect(provider, request):
        events = [event async for event in provider.stream(request)]
        return events[-1].completion


if __name__ == "__main__":
    unittest.main()
