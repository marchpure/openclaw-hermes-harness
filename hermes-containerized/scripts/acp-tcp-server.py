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
import json
import logging
import os
import shlex
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
OPENCLAW_RUNTIME_DIR = ".openclaw"
CREDENTIAL_MANIFEST_FILENAME = "credential-manifest.json"
_SESSION_MANAGER = None


def _read_openclaw_credential_env(cwd: str | None) -> dict[str, str]:
    """Load OpenClaw session-scoped credential env from the projected execenv."""
    if not cwd:
        return {}

    try:
        runtime_dir = Path(cwd) / OPENCLAW_RUNTIME_DIR
        manifest_path = runtime_dir / CREDENTIAL_MANIFEST_FILENAME
        if not manifest_path.is_file():
            return {}
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        env_file = data.get("envFile") if isinstance(data, dict) else None
        if not isinstance(env_file, str) or not env_file.strip():
            return {}
        env_path = Path(cwd) / env_file
        if not env_path.is_file():
            return {}

        env_vars: dict[str, str] = {}
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, raw_value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            if not key:
                continue
            try:
                parsed = shlex.split(raw_value, comments=False, posix=True)
                value = parsed[0] if parsed else ""
            except ValueError:
                value = raw_value.strip().strip("\"'")
            env_vars[key] = value
        return env_vars
    except Exception:
        logger.debug("Failed to load projected credentials from %s", cwd, exc_info=True)
        return {}


def _register_openclaw_session_env(session_id: str, cwd: str) -> None:
    try:
        from tools.terminal_tool import register_task_env_overrides
    except Exception:
        logger.debug("Hermes terminal override API unavailable", exc_info=True)
        return

    overrides: dict[str, str] = {"cwd": cwd}
    overrides.update(_read_openclaw_credential_env(cwd))
    register_task_env_overrides(session_id, overrides)
    logger.info(
        "Registered ACP session overrides for %s (cwd=%s, env_keys=%s)",
        session_id,
        cwd,
        sorted([key for key in overrides.keys() if key != "cwd"]),
    )


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
            _register_openclaw_session_env(session_id, cwd)
        except Exception:
            logger.debug("Failed to register ACP task env override", exc_info=True)

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
        try:
            _register_openclaw_session_env(session_id, cwd)
        except Exception:
            logger.debug("Failed to refresh ACP task env override", exc_info=True)
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


def _patch_hermes_runtime_hot_path() -> None:
    """Short-circuit expensive per-session probes on the OpenClaw ACP path.

    Hermes creates a fresh AIAgent for many OpenClaw turns. In the stock
    runtime that means:
    1. probing model metadata over the network to infer context length
    2. walking the auxiliary-provider auto-detect chain on every session

    OpenClaw already knows the routed model/base URL, so for the ACP bridge we
    can safely provide stable defaults and avoid repeated cold-start work.
    """
    from agent import model_metadata
    from agent import auxiliary_client

    if getattr(model_metadata, "_openclaw_context_patch", False):
        return

    original_get_model_context_length = model_metadata.get_model_context_length

    def get_model_context_length(
        model: str,
        base_url: str = "",
        api_key: str = "",
        config_context_length: int | None = None,
        provider: str = "",
    ) -> int:
        if isinstance(config_context_length, int) and config_context_length > 0:
            return config_context_length

        model_id = (model or "").strip()
        provider_id = (provider or "").strip().lower()
        base = (base_url or "").strip().lower()

        if model_id == "doubao-seed-2-0-pro-260215":
            if provider_id in {"custom", "ark", "model_square"}:
                return 200_000
            if "volceapi.com" in base or "ark.cn-beijing.volces.com" in base:
                return 200_000

        return original_get_model_context_length(
            model,
            base_url=base_url,
            api_key=api_key,
            config_context_length=config_context_length,
            provider=provider,
        )

    model_metadata.get_model_context_length = get_model_context_length
    model_metadata._openclaw_context_patch = True

    original_resolve_provider_client = auxiliary_client.resolve_provider_client
    original_resolve_auto = getattr(auxiliary_client, "_resolve_auto", None)

    def resolve_provider_client(
        provider: str,
        model: str = None,
        async_mode: bool = False,
        raw_codex: bool = False,
        explicit_base_url: str = None,
        explicit_api_key: str = None,
        api_mode: str = None,
        main_runtime: dict[str, Any] | None = None,
    ):
        normalized = (provider or "").strip().lower()

        # ACP/OpenClaw already routes the main runtime explicitly. Reusing that
        # avoids the expensive "auto" chain on every short-lived auxiliary call.
        if normalized in {"", "auto"} and isinstance(main_runtime, dict):
            main_provider = str(main_runtime.get("provider") or "").strip()
            main_model = str(main_runtime.get("model") or model or "").strip()
            main_base_url = str(main_runtime.get("base_url") or explicit_base_url or "").strip()
            main_api_key = str(main_runtime.get("api_key") or explicit_api_key or "").strip()
            if main_provider and main_model:
                return original_resolve_provider_client(
                    main_provider,
                    model=main_model,
                    async_mode=async_mode,
                    raw_codex=raw_codex,
                    explicit_base_url=main_base_url or None,
                    explicit_api_key=main_api_key or None,
                    api_mode=api_mode,
                    main_runtime=main_runtime,
                )

        return original_resolve_provider_client(
            provider,
            model=model,
            async_mode=async_mode,
            raw_codex=raw_codex,
            explicit_base_url=explicit_base_url,
            explicit_api_key=explicit_api_key,
            api_mode=api_mode,
            main_runtime=main_runtime,
        )

    auxiliary_client.resolve_provider_client = resolve_provider_client

    if callable(original_resolve_auto):
        def _resolve_auto(*args: Any, **kwargs: Any):
            main_runtime = kwargs.get("main_runtime")
            if isinstance(main_runtime, dict):
                main_provider = str(main_runtime.get("provider") or "").strip()
                main_model = str(main_runtime.get("model") or "").strip()
                if main_provider and main_model:
                    return original_resolve_provider_client(
                        main_provider,
                        model=main_model,
                        async_mode=kwargs.get("async_mode", False),
                        explicit_base_url=main_runtime.get("base_url"),
                        explicit_api_key=main_runtime.get("api_key"),
                        api_mode=kwargs.get("api_mode"),
                        main_runtime=main_runtime,
                    )
            return original_resolve_auto(*args, **kwargs)

        auxiliary_client._resolve_auto = _resolve_auto

    logger.info("Installed OpenClaw hot-path patch for Hermes model metadata and auxiliary routing")


def _get_shared_session_manager():
    """Reuse one SessionManager across TCP clients.

    The stock bridge creates a fresh HermesACPAgent per TCP connection. When
    each agent also constructs its own SessionManager, Hermes repeats provider
    setup and model metadata probing for every short-lived OpenClaw request.
    Sharing the manager keeps ACP session state process-local and removes that
    repeated initialization cost from the hot path.
    """
    global _SESSION_MANAGER
    if _SESSION_MANAGER is None:
        from acp_adapter.session import SessionManager

        _SESSION_MANAGER = SessionManager()
        logger.info("Created shared Hermes ACP SessionManager")
    return _SESSION_MANAGER


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    """Handle one TCP client — create a fresh ACP agent and bridge I/O."""
    import acp
    from acp_adapter.server import HermesACPAgent

    _patch_hermes_acp_model_routing()
    _patch_hermes_runtime_hot_path()

    peer = writer.get_extra_info("peername")
    logger.info("Client connected: %s", peer)

    agent = HermesACPAgent(session_manager=_get_shared_session_manager())

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
    _patch_hermes_acp_model_routing()
    _get_shared_session_manager()

    host = os.environ.get("ACP_TCP_HOST", "0.0.0.0")
    port = int(os.environ.get("ACP_TCP_PORT", "3100"))

    logger.info("Starting ACP TCP bridge on %s:%d", host, port)
    asyncio.run(run_server(host, port))


if __name__ == "__main__":
    main()
