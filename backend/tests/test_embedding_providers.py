import unittest

from backend.app.providers.embedding_providers import (
    EmbeddingBatch,
    EmbeddingProvider,
    EmbeddingRequest,
)


class StubEmbeddingProvider:
    def __init__(self) -> None:
        self.requests: list[EmbeddingRequest] = []

    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
        self.requests.append(request)
        return EmbeddingBatch(
            model=request.model,
            dimensions=2,
            vectors=tuple((1.0, 0.0) for _ in request.inputs),
        )


class EmbeddingProviderContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_batch_order_through_the_provider_boundary(self) -> None:
        provider = StubEmbeddingProvider()
        request = EmbeddingRequest(
            provider="ollama",
            model="nomic-embed-text",
            base_url="http://127.0.0.1:11434",
            api_key=None,
            inputs=("first chunk", "second chunk"),
        )

        result = await provider.embed(request)

        self.assertIsInstance(provider, EmbeddingProvider)
        self.assertEqual(provider.requests, [request])
        self.assertEqual(result.model, "nomic-embed-text")
        self.assertEqual(result.dimensions, 2)
        self.assertEqual(len(result.vectors), len(request.inputs))

    def test_keeps_credentials_out_of_the_embedding_result(self) -> None:
        result_fields = set(EmbeddingBatch.__dataclass_fields__)
        self.assertNotIn("api_key", result_fields)
        self.assertEqual(result_fields, {"model", "dimensions", "vectors"})


if __name__ == "__main__":
    unittest.main()
