import math
from urllib.parse import urlunsplit

import httpx

from .embedding_providers import (
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_MODEL_CHARACTERS,
    EmbeddingBatch,
    EmbeddingProviderName,
    EmbeddingRequest,
)
from .providers import (
    ProviderAddressResolver,
    ProviderError,
    is_loopback_provider_hostname,
    provider_http_error,
    resolve_provider_addresses,
    resolve_provider_destination,
    validate_provider_base_url,
)


DEFAULT_EMBEDDING_TIMEOUT_SECONDS = 120.0
MAX_EMBEDDING_INPUT_CHARACTERS = 20_000
MAX_EMBEDDING_TOTAL_INPUT_CHARACTERS = 256_000
MAX_EMBEDDING_BASE_URL_CHARACTERS = 2_048
MAX_EMBEDDING_API_KEY_CHARACTERS = 8_192


class HttpEmbeddingProvider:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
        address_resolver: ProviderAddressResolver | None = None,
    ) -> None:
        if not 1 <= timeout_seconds <= 1_800:
            raise ValueError("Embedding timeout must be between 1 and 1800 seconds.")
        self._transport = transport
        self._timeout_seconds = timeout_seconds
        self._address_resolver = address_resolver or resolve_provider_addresses

    async def embed(self, request: EmbeddingRequest) -> EmbeddingBatch:
        _validate_embedding_request(request)
        endpoint = create_embeddings_url(request.base_url, request.provider)
        destination = await resolve_provider_destination(
            endpoint,
            self._address_resolver,
        )
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Host": destination.host_header,
        }
        if request.api_key:
            headers["Authorization"] = f"Bearer {request.api_key}"

        payload: dict[str, object] = {
            "model": request.model.strip(),
            "input": list(request.inputs),
        }
        if request.provider == "ollama":
            payload["truncate"] = False
        else:
            payload["encoding_format"] = "float"

        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=self._timeout_seconds,
                follow_redirects=False,
            ) as client:
                response = await client.post(
                    destination.url,
                    headers=headers,
                    json=payload,
                    extensions={"sni_hostname": destination.sni_hostname},
                )
        except httpx.TimeoutException as error:
            raise ProviderError(
                "The embedding provider timed out before returning vectors.",
                504,
            ) from error
        except httpx.RequestError as error:
            raise ProviderError(
                "DevMate could not reach the configured embedding provider.",
                502,
            ) from error

        if response.is_redirect:
            raise ProviderError(
                "The embedding provider returned a redirect. Check the profile base URL.",
                502,
                "provider_invalid_response",
            )
        if response.status_code >= 400:
            raise provider_http_error(response)

        try:
            response_payload = response.json()
        except ValueError as error:
            raise _invalid_embedding_response("returned a non-JSON response") from error

        return _read_embedding_batch(request, response_payload)


def create_embeddings_url(
    configured_base_url: str,
    provider: EmbeddingProviderName,
) -> str:
    if provider not in {"ollama", "openai-compatible"}:
        raise ProviderError("Choose a supported embedding provider.", 400)
    parsed = validate_provider_base_url(
        configured_base_url,
        profile_label="embedding",
    )
    path = parsed.path.rstrip("/")
    if provider == "ollama":
        if path.endswith("/api/embed"):
            endpoint_path = path
        elif path.endswith("/api"):
            endpoint_path = f"{path}/embed"
        elif path.endswith("/v1"):
            endpoint_path = f"{path[:-3]}/api/embed"
        else:
            endpoint_path = f"{path}/api/embed"
    elif path.endswith("/embeddings"):
        endpoint_path = path
    else:
        endpoint_path = f"{path}/embeddings"
    return urlunsplit((parsed.scheme, parsed.netloc, endpoint_path, "", ""))


def _validate_embedding_request(request: EmbeddingRequest) -> None:
    if request.provider not in {"ollama", "openai-compatible"}:
        raise ProviderError("Choose a supported embedding provider.", 400)
    model = request.model.strip()
    if not model or len(model) > MAX_EMBEDDING_MODEL_CHARACTERS:
        raise ProviderError("The embedding profile has an invalid model ID.", 400)
    if not request.base_url or len(request.base_url) > MAX_EMBEDDING_BASE_URL_CHARACTERS:
        raise ProviderError("The embedding profile has an invalid base URL.", 400)
    if request.api_key is not None and (
        not isinstance(request.api_key, str)
        or not request.api_key.strip()
        or len(request.api_key) > MAX_EMBEDDING_API_KEY_CHARACTERS
    ):
        raise ProviderError("The embedding profile has an invalid API key.", 400)
    if not isinstance(request.remote_allowed, bool):
        raise ProviderError("The embedding profile has invalid remote consent.", 400)
    parsed = validate_provider_base_url(
        request.base_url,
        profile_label="embedding",
    )
    if (
        not request.remote_allowed
        and not is_loopback_provider_hostname(parsed.hostname)
    ):
        raise ProviderError(
            "Remote embedding providers require explicit opt-in.",
            400,
        )
    if not 1 <= len(request.inputs) <= MAX_EMBEDDING_BATCH_SIZE:
        raise ProviderError(
            f"Embedding batches must contain 1 to {MAX_EMBEDDING_BATCH_SIZE} inputs.",
            400,
        )

    total_characters = 0
    for value in request.inputs:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > MAX_EMBEDDING_INPUT_CHARACTERS
        ):
            raise ProviderError(
                "An embedding input is empty, invalid, or too large.",
                400,
            )
        total_characters += len(value)
    if total_characters > MAX_EMBEDDING_TOTAL_INPUT_CHARACTERS:
        raise ProviderError("The embedding batch contains too much text.", 400)


def _read_embedding_batch(
    request: EmbeddingRequest,
    payload: object,
) -> EmbeddingBatch:
    if not isinstance(payload, dict):
        raise _invalid_embedding_response("returned an invalid response object")
    response_model = payload.get("model")
    if (
        not isinstance(response_model, str)
        or not response_model.strip()
        or len(response_model) > MAX_EMBEDDING_MODEL_CHARACTERS
    ):
        raise _invalid_embedding_response("returned an invalid model ID")

    if request.provider == "ollama":
        raw_vectors = payload.get("embeddings")
        if not isinstance(raw_vectors, list):
            raise _invalid_embedding_response("returned invalid Ollama embeddings")
        ordered_vectors = raw_vectors
    else:
        ordered_vectors = _read_openai_vectors(payload.get("data"), len(request.inputs))

    vectors, dimensions = _normalize_vectors(ordered_vectors, len(request.inputs))
    return EmbeddingBatch(
        model=response_model.strip(),
        dimensions=dimensions,
        vectors=vectors,
    )


def _read_openai_vectors(value: object, expected_count: int) -> list[object]:
    if not isinstance(value, list) or len(value) != expected_count:
        raise _invalid_embedding_response("returned the wrong number of embeddings")
    ordered: list[object | None] = [None] * expected_count
    for item in value:
        if not isinstance(item, dict):
            raise _invalid_embedding_response("returned an invalid embedding item")
        index = item.get("index")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not 0 <= index < expected_count
            or ordered[index] is not None
        ):
            raise _invalid_embedding_response("returned invalid embedding indexes")
        ordered[index] = item.get("embedding")
    if any(vector is None for vector in ordered):
        raise _invalid_embedding_response("omitted an embedding vector")
    return list(ordered)


def _normalize_vectors(
    value: list[object],
    expected_count: int,
) -> tuple[tuple[tuple[float, ...], ...], int]:
    if len(value) != expected_count:
        raise _invalid_embedding_response("returned the wrong number of embeddings")

    dimensions: int | None = None
    normalized_vectors: list[tuple[float, ...]] = []
    for raw_vector in value:
        if not isinstance(raw_vector, list):
            raise _invalid_embedding_response("returned a non-array embedding")
        if not 1 <= len(raw_vector) <= MAX_EMBEDDING_DIMENSIONS:
            raise _invalid_embedding_response("returned unsupported embedding dimensions")
        if dimensions is None:
            dimensions = len(raw_vector)
        elif len(raw_vector) != dimensions:
            raise _invalid_embedding_response("returned inconsistent embedding dimensions")

        vector: list[float] = []
        for raw_value in raw_vector:
            if (
                not isinstance(raw_value, (int, float))
                or isinstance(raw_value, bool)
            ):
                raise _invalid_embedding_response("returned a non-numeric embedding value")
            numeric_value = float(raw_value)
            if not math.isfinite(numeric_value):
                raise _invalid_embedding_response("returned a non-finite embedding value")
            vector.append(numeric_value)

        norm = math.hypot(*vector)
        if not math.isfinite(norm) or norm == 0:
            raise _invalid_embedding_response("returned a zero or invalid embedding vector")
        normalized_vectors.append(tuple(component / norm for component in vector))

    if dimensions is None:
        raise _invalid_embedding_response("returned no embedding vectors")
    return tuple(normalized_vectors), dimensions


def _invalid_embedding_response(detail: str) -> ProviderError:
    return ProviderError(
        f"The embedding provider {detail}.",
        502,
        "provider_invalid_response",
    )
