import json
import math
import unittest

import httpx

from backend.app.providers.embedding_clients import (
    MAX_EMBEDDING_BATCH_SIZE,
    HttpEmbeddingProvider,
    create_embeddings_url,
)
from backend.app.providers.embedding_providers import EmbeddingRequest
from backend.app.providers.chat_provider import ProviderError


class EmbeddingUrlTests(unittest.TestCase):
    def test_builds_native_ollama_and_openai_compatible_urls(self) -> None:
        expected = {
            ("http://127.0.0.1:11434", "ollama"): (
                "http://127.0.0.1:11434/api/embed"
            ),
            ("http://127.0.0.1:11434/api", "ollama"): (
                "http://127.0.0.1:11434/api/embed"
            ),
            ("http://127.0.0.1:11434/v1", "ollama"): (
                "http://127.0.0.1:11434/api/embed"
            ),
            ("https://provider.example.com/v1", "openai-compatible"): (
                "https://provider.example.com/v1/embeddings"
            ),
            ("https://provider.example.com/v1/embeddings", "openai-compatible"): (
                "https://provider.example.com/v1/embeddings"
            ),
        }
        for (base_url, provider), endpoint in expected.items():
            with self.subTest(base_url=base_url, provider=provider):
                self.assertEqual(
                    create_embeddings_url(base_url, provider),  # type: ignore[arg-type]
                    endpoint,
                )

    def test_reuses_remote_https_and_unsafe_address_policy(self) -> None:
        with self.assertRaisesRegex(ProviderError, "must use HTTPS"):
            create_embeddings_url(
                "http://provider.example.com/v1",
                "openai-compatible",
            )
        with self.assertRaisesRegex(ProviderError, "unsafe network address"):
            create_embeddings_url(
                "https://169.254.169.254/v1",
                "openai-compatible",
            )


class HttpEmbeddingProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_openai_batch_and_restores_index_order(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            payload = json.loads(request.content)
            self.assertEqual(payload, {
                "model": "embed-model",
                "input": ["first", "second"],
                "encoding_format": "float",
            })
            return httpx.Response(200, json={
                "model": "embed-model",
                "data": [
                    {"index": 1, "embedding": [0.0, 2.0]},
                    {"index": 0, "embedding": [3.0, 4.0]},
                ],
            })

        provider = HttpEmbeddingProvider(
            transport=httpx.MockTransport(handler),
            address_resolver=self._resolve_public_provider,
        )
        result = await provider.embed(self._request(
            provider="openai-compatible",
            base_url="https://provider.example.com/v1",
            api_key="secret-key",
            remote_allowed=True,
        ))

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.host, "93.184.216.34")
        self.assertEqual(requests[0].headers["host"], "provider.example.com")
        self.assertEqual(requests[0].headers["authorization"], "Bearer secret-key")
        self.assertEqual(result.model, "embed-model")
        self.assertEqual(result.dimensions, 2)
        self.assertAlmostEqual(result.vectors[0][0], 0.6)
        self.assertAlmostEqual(result.vectors[0][1], 0.8)
        self.assertEqual(result.vectors[1], (0.0, 1.0))

    async def test_sends_native_ollama_batch_without_silent_truncation(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            self.assertEqual(request.url.path, "/api/embed")
            self.assertEqual(json.loads(request.content), {
                "model": "embed-model",
                "input": ["first", "second"],
                "truncate": False,
            })
            return httpx.Response(200, json={
                "model": "embed-model",
                "embeddings": [[1.0, 0.0], [0.0, -4.0]],
            })

        provider = HttpEmbeddingProvider(
            transport=httpx.MockTransport(handler),
            address_resolver=self._resolve_loopback_provider,
        )
        result = await provider.embed(self._request())

        self.assertEqual(len(requests), 1)
        self.assertNotIn("authorization", requests[0].headers)
        self.assertEqual(result.vectors, ((1.0, 0.0), (0.0, -1.0)))

    async def test_rejects_unsafe_dns_before_sending_source_or_credentials(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={})

        async def unsafe_resolver(_hostname: str, _port: int) -> tuple[str, ...]:
            return ("10.0.0.2",)

        provider = HttpEmbeddingProvider(
            transport=httpx.MockTransport(handler),
            address_resolver=unsafe_resolver,
        )
        with self.assertRaisesRegex(ProviderError, "resolved to.*unsafe") as caught:
            await provider.embed(self._request(
                provider="openai-compatible",
                base_url="https://provider.example.com/v1",
                api_key="must-not-leak",
                remote_allowed=True,
            ))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(requests, [])

    async def test_requires_remote_consent_before_dns_or_network_access(self) -> None:
        requests: list[httpx.Request] = []
        resolutions: list[tuple[str, int]] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={})

        async def resolver(hostname: str, port: int) -> tuple[str, ...]:
            resolutions.append((hostname, port))
            return ("93.184.216.34",)

        provider = HttpEmbeddingProvider(
            transport=httpx.MockTransport(handler),
            address_resolver=resolver,
        )
        with self.assertRaisesRegex(ProviderError, "explicit opt-in") as caught:
            await provider.embed(self._request(
                provider="openai-compatible",
                base_url="https://provider.example.com/v1",
                api_key="must-not-leak",
            ))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(resolutions, [])
        self.assertEqual(requests, [])

    async def test_rejects_invalid_or_oversized_inputs_before_network_access(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={})

        provider = HttpEmbeddingProvider(transport=httpx.MockTransport(handler))
        invalid_inputs = (
            (),
            ("   ",),
            tuple("chunk" for _ in range(MAX_EMBEDDING_BATCH_SIZE + 1)),
        )
        for inputs in invalid_inputs:
            with self.subTest(input_count=len(inputs)):
                with self.assertRaises(ProviderError) as caught:
                    await provider.embed(self._request(inputs=inputs))
                self.assertEqual(caught.exception.status_code, 400)

        with self.assertRaisesRegex(ProviderError, "invalid API key"):
            await provider.embed(self._request(api_key="   "))

        self.assertEqual(requests, [])

    async def test_rejects_malformed_mismatched_and_unsafe_vectors(self) -> None:
        responses = (
            {"model": "embed-model", "embeddings": [[1.0, 0.0]]},
            {"model": "embed-model", "embeddings": [[1.0], [1.0, 0.0]]},
            {"model": "embed-model", "embeddings": [[0.0, 0.0], [1.0, 0.0]]},
            {"model": "embed-model", "embeddings": [[math.nan, 1.0], [1.0, 0.0]]},
            {"model": "embed-model", "embeddings": [[True, 0.0], [1.0, 0.0]]},
        )
        for response_payload in responses:
            with self.subTest(response=response_payload):
                provider = HttpEmbeddingProvider(
                    transport=httpx.MockTransport(
                        lambda _request: httpx.Response(
                            200,
                            content=json.dumps(
                                response_payload,
                                allow_nan=True,
                            ).encode("utf-8"),
                            headers={"Content-Type": "application/json"},
                        )
                    ),
                    address_resolver=self._resolve_loopback_provider,
                )
                with self.assertRaises(ProviderError) as caught:
                    await provider.embed(self._request())
                self.assertEqual(caught.exception.status_code, 502)
                self.assertEqual(caught.exception.error_code, "provider_invalid_response")

    async def test_rejects_invalid_openai_indexes(self) -> None:
        for data in (
            [
                {"index": 0, "embedding": [1.0]},
                {"index": 0, "embedding": [1.0]},
            ],
            [
                {"index": 0, "embedding": [1.0]},
                {"index": 3, "embedding": [1.0]},
            ],
        ):
            with self.subTest(data=data):
                provider = HttpEmbeddingProvider(
                    transport=httpx.MockTransport(
                        lambda _request: httpx.Response(200, json={
                            "model": "embed-model",
                            "data": data,
                        })
                    ),
                    address_resolver=self._resolve_public_provider,
                )
                with self.assertRaises(ProviderError) as caught:
                    await provider.embed(self._request(
                        provider="openai-compatible",
                        base_url="https://provider.example.com/v1",
                        remote_allowed=True,
                    ))
                self.assertEqual(caught.exception.error_code, "provider_invalid_response")

    async def test_maps_provider_errors_timeouts_and_invalid_json(self) -> None:
        cases = (
            (
                httpx.MockTransport(
                    lambda _request: httpx.Response(
                        401,
                        json={"error": {"message": "Bad embedding key"}},
                    )
                ),
                401,
                "provider_authentication_failed",
            ),
            (
                httpx.MockTransport(
                    lambda request: (_ for _ in ()).throw(
                        httpx.ReadTimeout("timed out", request=request)
                    )
                ),
                504,
                "provider_timeout",
            ),
            (
                httpx.MockTransport(
                    lambda _request: httpx.Response(200, content=b"not json")
                ),
                502,
                "provider_invalid_response",
            ),
        )
        for transport, status_code, error_code in cases:
            with self.subTest(status_code=status_code, error_code=error_code):
                provider = HttpEmbeddingProvider(
                    transport=transport,
                    address_resolver=self._resolve_loopback_provider,
                )
                with self.assertRaises(ProviderError) as caught:
                    await provider.embed(self._request())
                self.assertEqual(caught.exception.status_code, status_code)
                self.assertEqual(caught.exception.error_code, error_code)

    @staticmethod
    async def _resolve_loopback_provider(
        _hostname: str,
        _port: int,
    ) -> tuple[str, ...]:
        return ("127.0.0.1",)

    @staticmethod
    async def _resolve_public_provider(
        _hostname: str,
        _port: int,
    ) -> tuple[str, ...]:
        return ("93.184.216.34",)

    @staticmethod
    def _request(
        *,
        provider: str = "ollama",
        base_url: str = "http://localhost:11434",
        api_key: str | None = None,
        inputs: tuple[str, ...] = ("first", "second"),
        remote_allowed: bool = False,
    ) -> EmbeddingRequest:
        return EmbeddingRequest(
            provider=provider,  # type: ignore[arg-type]
            model="embed-model",
            base_url=base_url,
            api_key=api_key,
            inputs=inputs,
            remote_allowed=remote_allowed,
        )


if __name__ == "__main__":
    unittest.main()
