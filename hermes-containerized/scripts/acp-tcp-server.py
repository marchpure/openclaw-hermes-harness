#!/usr/bin/env python3
"""ACP TCP Bridge — Exposes Hermes ACP agent over TCP.

Listens on a TCP port (default 3100) and bridges each connection to
the Hermes ACP agent using asyncio streams, speaking the same JSON-RPC
protocol as stdio ACP but over TCP.

Usage:
    python acp-tcp-server.py [--port PORT] [--host HOST]

Environment:
    ACP_TCP_PORT  — port (default 3100)
    ACP_TCP_HOST  — bind address (default 0.0.0.0)
"""

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

# Ensure Hermes source is on sys.path
project_root = str(Path("/opt/hermes"))
if project_root not in sys.path:
    sys.path.insert(0, project_root)


def _setup_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)


def _load_env() -> None:
    from hermes_cli.env_loader import load_hermes_dotenv
    from hermes_constants import get_hermes_home

    hermes_home = get_hermes_home()
    load_hermes_dotenv(hermes_home=hermes_home)


logger = logging.getLogger("acp-tcp-server")


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    """Handle one TCP client — create a fresh ACP agent and bridge I/O."""
    import acp
    from acp_adapter.server import HermesACPAgent

    peer = writer.get_extra_info("peername")
    logger.info("Client connected: %s", peer)

    agent = HermesACPAgent()

    try:
        # AgentSideConnection takes:
        #   input_stream=StreamWriter (agent writes TO client)
        #   output_stream=StreamReader (agent reads FROM client)
        conn = acp.AgentSideConnection(
            agent,
            input_stream=writer,
            output_stream=reader,
            listening=False,
            use_unstable_protocol=True,
        )
        # listen() runs the receive loop until the connection closes
        await conn.listen()
    except (ConnectionResetError, asyncio.IncompleteReadError, BrokenPipeError):
        logger.info("Client disconnected: %s", peer)
    except Exception:
        logger.exception("Error handling client %s", peer)
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        logger.info("Client session ended: %s", peer)


async def run_server(host: str, port: int) -> None:
    server = await asyncio.start_server(handle_client, host, port)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    logger.info("ACP TCP server listening on %s", addrs)

    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stop.set_result(None))

    async with server:
        await stop
    logger.info("Server shutting down")


def main() -> None:
    _setup_logging()
    _load_env()

    host = os.environ.get("ACP_TCP_HOST", "0.0.0.0")
    port = int(os.environ.get("ACP_TCP_PORT", "3100"))

    logger.info("Starting ACP TCP bridge on %s:%d", host, port)
    asyncio.run(run_server(host, port))


if __name__ == "__main__":
    main()
