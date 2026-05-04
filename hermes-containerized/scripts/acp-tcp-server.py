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
import datetime
import json
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Any

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


def _read_projected_model(cwd: str | None) -> str | None:
    """Read OpenClaw's projected runtime model from cwd/runtime-config.json."""
    if not cwd:
        return None
    try:
        config_path = Path(cwd) / "runtime-config.json"
        if not config_path.is_file():
            return None
        data = json.loads(config_path.read_text(encoding="utf-8"))
        model = data.get("model") if isinstance(data, dict) else None
        if isinstance(model, str) and model.strip():
            return model.strip()
    except Exception:
        logger.debug("Failed to read projected model from %s", cwd, exc_info=True)
    return None


def _to_positive_float(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number <= 0:
        return default
    return number


def _read_tcp_port() -> int:
    raw = os.environ.get("ACP_TCP_PORT", "3100")
    try:
        port = int(raw)
    except (TypeError, ValueError):
        raise SystemExit(f"ACP_TCP_PORT must be an integer between 1 and 65535, got {raw!r}")
    if port < 1 or port > 65535:
        raise SystemExit(f"ACP_TCP_PORT must be an integer between 1 and 65535, got {raw!r}")
    return port


def _read_openclaw_mcp_meta(server: Any) -> dict[str, Any]:
    raw_meta = getattr(server, "field_meta", None)
    if raw_meta is None and hasattr(server, "model_dump"):
        try:
            raw_meta = server.model_dump(by_alias=True).get("_meta")
        except Exception:
            raw_meta = None
    if not isinstance(raw_meta, dict):
        return {}
    openclaw_meta = raw_meta.get("openclaw")
    return openclaw_meta if isinstance(openclaw_meta, dict) else {}


def _patch_hermes_mcp_runtime_options() -> None:
    """Make ACP-provided MCP runtime options survive into Hermes MCP calls.

    The upstream Hermes ACP adapter currently converts ACP HTTP MCP servers to
    only {url, headers}, dropping `_meta` and any runtime-specific timeouts.
    It also leaves MCP SDK call_tool read timeouts at the SDK default. OpenClaw
    passes its loopback bridge options under `_meta.openclaw` so ACP clients
    remain spec-compatible while this container adapter maps them into Hermes'
    native mcp_servers config shape.
    """
    from acp.schema import McpServerHttp, McpServerSse, McpServerStdio
    from acp_adapter.server import HermesACPAgent

    if getattr(HermesACPAgent, "_openclaw_mcp_options_patch", False):
        return

    def force_reconnect_session_scoped_servers(server_names: list[str]) -> None:
        if not server_names:
            return
        try:
            import tools.mcp_tool as mcp_tool
        except Exception:
            logger.debug("MCP tool module unavailable during reconnect refresh", exc_info=True)
            return

        mcp_tool._ensure_mcp_loop()

        async def shutdown_existing() -> None:
            for server_name in server_names:
                with mcp_tool._lock:
                    server = mcp_tool._servers.pop(server_name, None)
                    mcp_tool._server_error_counts.pop(server_name, None)
                    mcp_tool._server_breaker_opened_at.pop(server_name, None)
                if server is None:
                    continue
                try:
                    await server.shutdown()
                    logger.info("MCP server '%s': refreshed session-scoped OpenClaw bridge", server_name)
                except Exception:
                    logger.debug("Failed to shut down stale MCP server '%s'", server_name, exc_info=True)

        try:
            mcp_tool._run_on_mcp_loop(shutdown_existing(), timeout=15)
        except Exception:
            logger.debug("Failed to refresh session-scoped MCP servers", exc_info=True)

    async def register_session_mcp_servers(self: Any, state: Any, mcp_servers: list | None) -> None:
        if not mcp_servers:
            return

        try:
            from tools.mcp_tool import register_mcp_servers

            config_map: dict[str, dict] = {}
            session_scoped_server_names: list[str] = []
            for server in mcp_servers:
                name = server.name
                meta = _read_openclaw_mcp_meta(server)
                if meta:
                    session_scoped_server_names.append(name)
                timeout = _to_positive_float(meta.get("timeout"), 600.0)
                connect_timeout = _to_positive_float(
                    meta.get("connectTimeout", meta.get("connect_timeout")),
                    60.0,
                )
                if isinstance(server, McpServerStdio):
                    config = {
                        "command": server.command,
                        "args": list(server.args),
                        "env": {item.name: item.value for item in server.env},
                    }
                else:
                    config = {
                        "url": server.url,
                        "headers": {item.name: item.value for item in server.headers},
                    }
                    if isinstance(server, McpServerSse):
                        config["type"] = "sse"
                config["timeout"] = timeout
                config["connect_timeout"] = connect_timeout
                config_map[name] = config

            force_reconnect_session_scoped_servers(session_scoped_server_names)
            await asyncio.to_thread(register_mcp_servers, config_map)
        except Exception:
            logger.warning(
                "Session %s: failed to register ACP MCP servers",
                state.session_id,
                exc_info=True,
            )
            return

        try:
            from model_tools import get_tool_definitions
            from acp_adapter.session import _expand_acp_enabled_toolsets

            enabled_toolsets = _expand_acp_enabled_toolsets(
                getattr(state.agent, "enabled_toolsets", None) or ["hermes-acp"],
                mcp_server_names=[server.name for server in mcp_servers],
            )
            state.agent.enabled_toolsets = enabled_toolsets
            disabled_toolsets = getattr(state.agent, "disabled_toolsets", None)
            state.agent.tools = get_tool_definitions(
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
                quiet_mode=True,
            )
            state.agent.valid_tool_names = {
                tool["function"]["name"] for tool in state.agent.tools or []
            }
            invalidate = getattr(state.agent, "_invalidate_system_prompt", None)
            if callable(invalidate):
                invalidate()
            logger.info(
                "Session %s: refreshed tool surface after ACP MCP registration (%d tools)",
                state.session_id,
                len(state.agent.tools or []),
            )
        except Exception:
            logger.warning(
                "Session %s: failed to refresh tool surface after ACP MCP registration",
                state.session_id,
                exc_info=True,
            )

    HermesACPAgent._register_session_mcp_servers = register_session_mcp_servers
    HermesACPAgent._openclaw_mcp_options_patch = True

    try:
        import tools.mcp_tool as mcp_tool
    except Exception:
        logger.warning("Failed to import Hermes MCP tool module for timeout patch", exc_info=True)
        return

    if getattr(mcp_tool, "_openclaw_call_timeout_patch", False):
        return

    original_make_tool_handler = mcp_tool._make_tool_handler

    def make_tool_handler(server_name: str, tool_name: str, tool_timeout: float):
        handler = original_make_tool_handler(server_name, tool_name, tool_timeout)

        def wrapped(args: dict, **kwargs: Any) -> str:
            with mcp_tool._lock:
                server = mcp_tool._servers.get(server_name)
            if server and server.session:
                original_call_tool = server.session.call_tool

                async def call_tool_with_timeout(name: str, arguments: dict | None = None, **call_kwargs: Any):
                    call_kwargs.setdefault(
                        "read_timeout_seconds",
                        datetime.timedelta(seconds=float(tool_timeout)),
                    )
                    return await original_call_tool(name, arguments=arguments, **call_kwargs)

                server.session.call_tool = call_tool_with_timeout
                try:
                    return handler(args, **kwargs)
                finally:
                    server.session.call_tool = original_call_tool
            return handler(args, **kwargs)

        return wrapped

    mcp_tool._make_tool_handler = make_tool_handler
    mcp_tool._openclaw_call_timeout_patch = True
    logger.info("Installed OpenClaw MCP runtime options patch for Hermes ACP")


def _patch_hermes_acp_model_routing() -> None:
    """Teach Hermes' ACP adapter to create sessions with per-request models.

    The stock Hermes ACP adapter builds AIAgent from HERMES_HOME/config.yaml and
    ignores OpenClaw's projected runtime-config.json. OpenClaw now sends model in
    session/new|resume when supported, while this fallback also reads cwd so old
    clients still route dynamically.
    """
    from acp_adapter.session import SessionManager, SessionState

    if getattr(SessionManager, "_openclaw_model_patch", False):
        return

    _patch_hermes_mcp_runtime_options()

    original_create_session = SessionManager.create_session
    original_update_cwd = SessionManager.update_cwd

    def create_session(self: Any, cwd: str = ".", model: str | None = None) -> SessionState:
        resolved_model = (model.strip() if isinstance(model, str) and model.strip() else None) or _read_projected_model(cwd)
        if not resolved_model:
            return original_create_session(self, cwd)

        import threading
        import uuid

        session_id = str(uuid.uuid4())
        agent = self._make_agent(session_id=session_id, cwd=cwd, model=resolved_model)
        # Some Hermes provider resolution paths normalize or fall back to the
        # config default during AIAgent initialization. OpenClaw routing is
        # explicit, so force the selected model after the agent has built its
        # client; subsequent API calls read agent.model.
        try:
            agent.model = resolved_model
        except Exception:
            logger.debug("Failed to force ACP session model", exc_info=True)
        state = SessionState(
            session_id=session_id,
            agent=agent,
            cwd=cwd,
            model=getattr(agent, "model", "") or resolved_model,
            cancel_event=threading.Event(),
        )
        with self._lock:
            self._sessions[session_id] = state
        self._persist(state)

        try:
            from tools.terminal_tool import register_task_env_overrides
            register_task_env_overrides(session_id, {"cwd": cwd})
        except Exception:
            logger.debug("Failed to register ACP task cwd override", exc_info=True)

        logger.info("Created ACP session %s (cwd=%s, model=%s)", session_id, cwd, state.model)
        return state

    def update_cwd(self: Any, session_id: str, cwd: str, model: str | None = None) -> SessionState | None:
        state = original_update_cwd(self, session_id, cwd)
        if state is None:
            return None
        resolved_model = (model.strip() if isinstance(model, str) and model.strip() else None) or _read_projected_model(cwd)
        if resolved_model and state.model != resolved_model:
            logger.info(
                "ACP session %s model changed from %s to %s; recreating agent",
                session_id,
                state.model,
                resolved_model,
            )
            state.agent = self._make_agent(session_id=session_id, cwd=cwd, model=resolved_model)
            try:
                state.agent.model = resolved_model
            except Exception:
                logger.debug("Failed to force resumed ACP session model", exc_info=True)
            state.model = getattr(state.agent, "model", "") or resolved_model
            state.history = []
            self._persist(state)
        return state

    SessionManager.create_session = create_session
    SessionManager.update_cwd = update_cwd
    SessionManager._openclaw_model_patch = True

    from acp_adapter.server import HermesACPAgent

    original_new_session = HermesACPAgent.new_session
    original_resume_session = HermesACPAgent.resume_session
    original_load_session = HermesACPAgent.load_session

    async def new_session(self: Any, cwd: str, mcp_servers: list | None = None, model: str | None = None, **kwargs: Any):
        state = self.session_manager.create_session(cwd=cwd, model=model)
        await self._register_session_mcp_servers(state, mcp_servers)
        logger.info("New session %s (cwd=%s, model=%s)", state.session_id, cwd, state.model)
        self._schedule_available_commands_update(state.session_id)
        from acp.schema import NewSessionResponse
        return NewSessionResponse(session_id=state.session_id)

    async def resume_session(
        self: Any,
        cwd: str,
        session_id: str,
        mcp_servers: list | None = None,
        model: str | None = None,
        **kwargs: Any,
    ):
        state = self.session_manager.update_cwd(session_id, cwd, model=model)
        if state is None:
            logger.warning("resume_session: session %s not found, creating new", session_id)
            state = self.session_manager.create_session(cwd=cwd, model=model)
        await self._register_session_mcp_servers(state, mcp_servers)
        logger.info("Resumed session %s (model=%s)", state.session_id, state.model)
        self._schedule_available_commands_update(state.session_id)
        from acp.schema import ResumeSessionResponse
        return ResumeSessionResponse()

    async def load_session(
        self: Any,
        cwd: str,
        session_id: str,
        mcp_servers: list | None = None,
        model: str | None = None,
        **kwargs: Any,
    ):
        state = self.session_manager.update_cwd(session_id, cwd, model=model)
        if state is None:
            logger.warning("load_session: session %s not found", session_id)
            return None
        await self._register_session_mcp_servers(state, mcp_servers)
        logger.info("Loaded session %s (model=%s)", session_id, state.model)
        self._schedule_available_commands_update(session_id)
        from acp.schema import LoadSessionResponse
        return LoadSessionResponse()

    HermesACPAgent.new_session = new_session
    HermesACPAgent.resume_session = resume_session
    HermesACPAgent.load_session = load_session
    HermesACPAgent._openclaw_original_new_session = original_new_session
    HermesACPAgent._openclaw_original_resume_session = original_resume_session
    HermesACPAgent._openclaw_original_load_session = original_load_session
    logger.info("Installed OpenClaw dynamic model routing patch for Hermes ACP")


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    """Handle one TCP client — create a fresh ACP agent and bridge I/O."""
    import acp
    from acp_adapter.server import HermesACPAgent

    _patch_hermes_acp_model_routing()

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
    port = _read_tcp_port()

    logger.info("Starting ACP TCP bridge on %s:%d", host, port)
    asyncio.run(run_server(host, port))


if __name__ == "__main__":
    main()
