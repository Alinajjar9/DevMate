from __future__ import annotations

import argparse

import uvicorn

from backend.app.main import app


def _port(value: str) -> int:
    port = int(value)
    if not 1_024 <= port <= 65_535:
        raise argparse.ArgumentTypeError("port must be between 1024 and 65535")
    return port


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local DevMate backend.")
    parser.add_argument("--host", choices=("127.0.0.1", "::1"), default="127.0.0.1")
    parser.add_argument("--port", type=_port, default=8_000)
    arguments = parser.parse_args()
    uvicorn.run(
        app,
        host=arguments.host,
        port=arguments.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
