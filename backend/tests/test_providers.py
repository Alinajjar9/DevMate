import json
import unittest

import httpx

from backend.app.providers import (
    ChatCompletionRequest,
    ChatMessage,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    OpenAICompatibleProvider,
    ProviderError,
    create_chat_completions_url,
    parse_provider_timeout_seconds,
)


class ProviderUrlTests(unittest.TestCase):
    def test_provider_timeout_defaults_to_five_minutes(self) -> None:
        self.assertEqual(DEFAULT_PROVIDER_TIMEOUT_SECONDS, 300.0)
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

        answer = await provider.complete(self._request())

        self.assertEqual(answer, "Real answer")

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

        self.assertEqual(await provider.complete(request), "OpenAI answer")

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
    ) -> ChatCompletionRequest:
        return ChatCompletionRequest(
            provider="openai",
            model="nvidia/example-model",
            base_url=base_url,
            api_key=api_key,
            messages=(
                ChatMessage(role="system", content="System guidance"),
                ChatMessage(role="user", content="Hello"),
            ),
            max_tokens=1200,
            temperature=0.2,
        )


if __name__ == "__main__":
    unittest.main()
