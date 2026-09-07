# Shared network safety for chat and embedding providers.
# Check destinations before sending credentials or source text, and never follow redirects.

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

import httpx

from ..api.api_models import ProviderErrorCode


ProviderAddressResolver = Callable[[str, int], Awaitable[Sequence[str]]]


class ProviderError(Exception):
    def __init__(
        self,
        message: str,
        status_code: int = 502,
        error_code: ProviderErrorCode | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code or _provider_error_code_for_status(status_code)


def _provider_error_code_for_status(status_code: int) -> ProviderErrorCode:
    if status_code in {401, 403}:
        return "provider_authentication_failed"
    if status_code == 404:
        return "provider_not_found"
    if status_code == 429:
        return "provider_rate_limited"
    if status_code == 504:
        return "provider_timeout"
    if 400 <= status_code < 500:
        return "provider_configuration"
    return "provider_unavailable"


@dataclass(frozen=True)
class ResolvedProviderDestination:
    url: str
    host_header: str
    sni_hostname: str


def validate_provider_base_url(
    base_url: str,
    *,
    profile_label: str = "model",
) -> SplitResult:
    try:
        parsed = urlsplit(base_url.strip())
        hostname = parsed.hostname
    except ValueError as error:
        raise ProviderError(
            f"The {profile_label} profile has an invalid base URL.",
            400,
        ) from error
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ProviderError(
            f"The {profile_label} profile has an invalid base URL.",
            400,
        )
    if parsed.scheme == "http" and not is_loopback_provider_hostname(hostname):
        raise ProviderError(
            f"Remote {profile_label} providers must use HTTPS. "
            "Plain HTTP is allowed only for local loopback providers.",
            400,
        )
    literal_address = _provider_ip_address(hostname)
    if literal_address is not None and not _is_allowed_provider_address(
        literal_address,
        local_provider=is_loopback_provider_hostname(hostname),
    ):
        raise ProviderError(
            f"The {profile_label} provider URL points to a private or otherwise "
            "unsafe network address.",
            400,
        )

    return parsed


def is_loopback_provider_hostname(hostname: str | None) -> bool:
    if hostname is None:
        return False
    if hostname.casefold() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(hostname)
        return address.is_loopback and not (
            isinstance(address, ipaddress.IPv6Address)
            and address.ipv4_mapped is not None
        )
    except ValueError:
        return False


async def resolve_provider_addresses(hostname: str, port: int) -> tuple[str, ...]:
    try:
        records = await asyncio.get_running_loop().getaddrinfo(
            hostname,
            port,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except OSError as error:
        raise ProviderError(
            "DevMate could not resolve the configured model provider.",
            502,
        ) from error

    addresses: list[str] = []
    seen: set[str] = set()
    for _family, _socket_type, _protocol, _canonical_name, socket_address in records:
        address = socket_address[0]
        if address not in seen:
            seen.add(address)
            addresses.append(address)
    return tuple(addresses)


async def resolve_provider_destination(
    endpoint: str,
    address_resolver: ProviderAddressResolver = resolve_provider_addresses,
) -> ResolvedProviderDestination:
    parsed = urlsplit(endpoint)
    hostname = parsed.hostname
    if hostname is None:
        raise ProviderError("The model profile has an invalid base URL.", 400)
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise ProviderError("The model profile has an invalid base URL.", 400) from error

    literal_address = _provider_ip_address(hostname)
    if literal_address is not None:
        addresses = (literal_address,)
    else:
        try:
            resolved = await address_resolver(hostname, port)
        except ProviderError:
            raise
        except OSError as error:
            raise ProviderError(
                "DevMate could not resolve the configured model provider.",
                502,
            ) from error
        addresses = tuple(
            address
            for value in resolved
            if (address := _provider_ip_address(value)) is not None
        )
        if len(addresses) != len(resolved) or not addresses:
            raise ProviderError(
                "DevMate could not resolve the configured model provider to a valid address.",
                502,
            )

    # Reject the entire DNS answer if any address is unsafe, not just the selected address.
    local_provider = is_loopback_provider_hostname(hostname)
    if any(
        not _is_allowed_provider_address(address, local_provider=local_provider)
        for address in addresses
    ):
        raise ProviderError(
            "The model provider resolved to a private or otherwise unsafe network address.",
            400,
        )

    # Pin a checked IP but retain Host/TLS identity; a second DNS lookup could return a different IP.
    selected_address = min(
        addresses,
        key=lambda address: (address.version, address.compressed),
    )
    pinned_hostname = (
        f"[{selected_address.compressed}]"
        if selected_address.version == 6
        else selected_address.compressed
    )
    pinned_url = urlunsplit((
        parsed.scheme,
        f"{pinned_hostname}:{port}",
        parsed.path,
        "",
        "",
    ))
    host_header = httpx.URL(endpoint).netloc.decode("ascii")
    return ResolvedProviderDestination(
        url=pinned_url,
        host_header=host_header,
        sni_hostname=hostname,
    )


def _provider_ip_address(
    value: str | None,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    if value is None or "%" in value:
        return None
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _is_allowed_provider_address(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    local_provider: bool,
) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return False
    effective_address = address
    if local_provider:
        return effective_address.is_loopback
    return effective_address.is_global and not (
        effective_address.is_link_local
        or effective_address.is_loopback
        or effective_address.is_multicast
        or effective_address.is_private
        or effective_address.is_reserved
        or effective_address.is_unspecified
        or (
            isinstance(effective_address, ipaddress.IPv6Address)
            and effective_address.is_site_local
        )
    )


def provider_http_error(response: httpx.Response) -> ProviderError:
    detail = _read_error_detail(response)
    if response.status_code in {401, 403}:
        return ProviderError(
            detail or "The model provider rejected the API key.",
            401,
        )
    if response.status_code == 404:
        return ProviderError(
            detail or "The provider endpoint or selected model was not found.",
            404,
        )
    if response.status_code == 429:
        return ProviderError(
            detail or "The model provider rate limit was reached. Try again shortly.",
            429,
        )
    if 400 <= response.status_code < 500:
        return ProviderError(
            detail or "The model provider rejected the request.",
            400,
        )
    return ProviderError(
        detail or "The model provider is currently unavailable.",
        502,
    )


def _read_error_detail(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return _bounded_detail(error["message"])
    if isinstance(error, str):
        return _bounded_detail(error)
    detail = payload.get("detail")
    if isinstance(detail, str):
        return _bounded_detail(detail)
    return None


def _bounded_detail(value: str) -> str | None:
    normalized = " ".join(value.split())
    return normalized[:500] or None
