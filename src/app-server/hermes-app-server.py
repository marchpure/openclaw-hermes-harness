#!/usr/bin/env python3
"""Hermes OpenClaw App Server.

NDJSON JSON-RPC stdio server used by the OpenClaw Hermes harness. It exposes a
Codex-app-server-like turn protocol and forwards OpenClaw dynamic tool calls
back to the host plugin with item/tool/call requests.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

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

    load_hermes_dotenv(hermes_home=get_hermes_home())


logger = logging.getLogger("hermes-openclaw-app-server")


class RpcPeer:
    def __init__(self) -> None:
        self._next_id = 1
        self._pending: Dict[int, asyncio.Future] = {}
        self._write_lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def send_response(self, msg_id: Any, result: Any = None, error: Any = None) -> None:
        payload: Dict[str, Any] = {"id": msg_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result
        await self._write(payload)

    async def notify(self, method: str, params: Any = None) -> None:
        payload: Dict[str, Any] = {"method": method}
        if params is not None:
            payload["params"] = params
        await self._write(payload)

    async def request(self, method: str, params: Any = None, timeout: float = 300) -> Any:
        msg_id = self._next_id
        self._next_id += 1
        loop = self._loop or asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[msg_id] = future
        payload: Dict[str, Any] = {"id": msg_id, "method": method}
        if params is not None:
            payload["params"] = params
        await self._write(payload)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(msg_id, None)

    def handle_response(self, message: Dict[str, Any]) -> bool:
        if "id" not in message or "method" in message:
            return False
        future = self._pending.get(message["id"])
        if not future or future.done():
            return True
        if "error" in message:
            err = message.get("error") or {}
            future.set_exception(RuntimeError(err.get("message") or str(err)))
        else:
            future.set_result(message.get("result"))
        return True

    async def _write(self, payload: Dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self._write_lock:
            sys.stdout.write(line)
            sys.stdout.flush()


class HermesAppServer:
    def __init__(self) -> None:
        self.peer = RpcPeer()
        self.threads: Dict[str, Dict[str, Any]] = {}
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="hermes-app")

    async def handle_request(self, message: Dict[str, Any]) -> None:
        msg_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        try:
            if method == "initialize":
                result = {"server": "hermes-openclaw-app-server", "version": "0.1.0"}
            elif method == "thread/start":
                result = await self.thread_start(params)
            elif method == "turn/start":
                result = await self.turn_start(params)
            elif method == "turn/interrupt":
                result = await self.turn_interrupt(params)
            else:
                raise ValueError(f"Unknown method: {method}")
            if msg_id is not None:
                await self.peer.send_response(msg_id, result=result)
        except Exception as exc:
            logger.exception("request failed: %s", method)
            if msg_id is not None:
                await self.peer.send_response(
                    msg_id,
                    error={"code": -32000, "message": str(exc)},
                )

    async def thread_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        cwd = str(params.get("cwd") or ".")
        model = params.get("model")
        dynamic_tools = list(params.get("dynamicTools") or [])
        system_prompt = params.get("systemPrompt") or ""
        thread_id = str(uuid.uuid4())
        agent = self._make_agent(
            thread_id=thread_id,
            cwd=cwd,
            model=model if isinstance(model, str) and model else None,
            dynamic_tools=dynamic_tools,
            system_prompt=system_prompt if isinstance(system_prompt, str) else "",
        )
        self.threads[thread_id] = {
            "id": thread_id,
            "cwd": cwd,
            "agent": agent,
            "history": [],
            "dynamic_tools": dynamic_tools,
            "cancel": threading.Event(),
        }
        return {"thread": {"id": thread_id, "cwd": cwd}}

    async def turn_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        thread_id = str(params.get("threadId") or "")
        state = self.threads.get(thread_id)
        if state is None:
            raise ValueError(f"Unknown threadId: {thread_id}")
        turn_id = str(uuid.uuid4())
        input_items = params.get("input") or []
        user_text = "\n".join(
            item.get("text", "")
            for item in input_items
            if isinstance(item, dict) and item.get("type") == "text"
        ).strip()
        if not user_text:
            return {"turn": {"id": turn_id, "status": "completed"}}

        await self.peer.notify("item/started", {"threadId": thread_id, "turnId": turn_id, "itemId": "reasoning", "type": "reasoning"})

        loop = asyncio.get_running_loop()

        def run_agent() -> Dict[str, Any]:
            agent = state["agent"]
            state["cancel"].clear()
            try:
                return agent.run_conversation(
                    user_message=user_text,
                    conversation_history=state["history"],
                    task_id=thread_id,
                )
            except Exception as exc:
                logger.exception("Hermes turn failed")
                return {"final_response": f"Error: {exc}", "messages": state["history"], "_error": str(exc)}

        result = await loop.run_in_executor(self.executor, run_agent)
        state["history"] = result.get("messages") or state["history"]
        final_response = str(result.get("final_response") or "")
        if final_response:
            await self.peer.notify(
                "item/agentMessage/delta",
                {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": "assistant",
                    "delta": final_response,
                },
            )
        await self.peer.notify("item/completed", {"threadId": thread_id, "turnId": turn_id, "itemId": "assistant", "type": "agentMessage"})
        status = "failed" if result.get("_error") else "completed"
        completed = {
            "threadId": thread_id,
            "turnId": turn_id,
            "turn": {
                "id": turn_id,
                "status": status,
                **({"error": {"message": result.get("_error")}} if result.get("_error") else {}),
            },
        }
        await self.peer.notify("turn/completed", completed)
        return {
            "turn": completed["turn"],
            "usage": {
                "input_tokens": result.get("prompt_tokens") or 0,
                "output_tokens": result.get("completion_tokens") or 0,
                "total_tokens": result.get("total_tokens") or 0,
            },
        }

    async def turn_interrupt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        thread_id = str(params.get("threadId") or "")
        state = self.threads.get(thread_id)
        if state:
            state["cancel"].set()
            agent = state.get("agent")
            if hasattr(agent, "interrupt"):
                agent.interrupt()
        return {"ok": True}

    def _make_agent(
        self,
        *,
        thread_id: str,
        cwd: str,
        model: Optional[str],
        dynamic_tools: List[Dict[str, Any]],
        system_prompt: str,
    ) -> Any:
        from acp_adapter.session import _register_task_cwd
        from run_agent import AIAgent

        _register_task_cwd(thread_id, cwd)
        agent = AIAgent(
            model=model,
            session_id=thread_id,
            quiet_mode=True,
            enabled_toolsets=["hermes-acp"],
            ephemeral_system_prompt=system_prompt or None,
        )
        self._install_dynamic_tools(agent, thread_id, dynamic_tools)
        agent.tool_progress_callback = self._tool_progress_callback(thread_id)
        agent.thinking_callback = self._thinking_callback(thread_id)
        return agent

    def _install_dynamic_tools(self, agent: Any, thread_id: str, dynamic_tools: List[Dict[str, Any]]) -> None:
        if not dynamic_tools:
            return
        specs = []
        existing_names = set(getattr(agent, "valid_tool_names", set()) or set())
        names = set(existing_names)
        dynamic_names = set()
        peer = self.peer

        def make_handler(tool_name: str):
            def handler(args: dict, **kwargs: Any) -> str:
                call_id = str(kwargs.get("tool_call_id") or f"call_{uuid.uuid4().hex[:12]}")
                task_id = str(kwargs.get("task_id") or thread_id)
                coro = peer.request(
                    "item/tool/call",
                    {
                        "threadId": thread_id,
                        "turnId": task_id,
                        "callId": call_id,
                        "tool": tool_name,
                        "arguments": args or {},
                    },
                    timeout=600,
                )
                future = asyncio.run_coroutine_threadsafe(coro, peer._loop)
                response = future.result(timeout=620)
                items = response.get("contentItems") if isinstance(response, dict) else []
                texts = []
                for item in items or []:
                    if isinstance(item, dict) and item.get("type") == "inputText":
                        texts.append(str(item.get("text") or ""))
                    elif isinstance(item, dict) and item.get("type") == "inputImage":
                        texts.append(str(item.get("imageUrl") or ""))
                return "\n".join(texts) if texts else json.dumps(response, ensure_ascii=False)
            return handler

        try:
            from tools.registry import registry
        except Exception:
            registry = None

        for tool in dynamic_tools:
            name = tool.get("name")
            if not isinstance(name, str) or not name:
                continue
            if name in existing_names:
                logger.info("Skipping OpenClaw dynamic tool %s because Hermes already has a tool with that name", name)
                continue
            schema = tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else {}
            specs.append({
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(tool.get("description") or ""),
                    "parameters": schema or {"type": "object", "properties": {}},
                },
            })
            names.add(name)
            dynamic_names.add(name)
            if registry is not None:
                registry.register(
                    name=name,
                    toolset="openclaw-dynamic",
                    schema={
                        "name": name,
                        "description": str(tool.get("description") or ""),
                        "parameters": schema or {"type": "object", "properties": {}},
                    },
                    handler=make_handler(name),
                    description=str(tool.get("description") or ""),
                    emoji="🔧",
                )
        agent.tools = list(agent.tools or []) + specs
        agent.valid_tool_names = names

        original_invoke = agent._invoke_tool

        def invoke(function_name: str, function_args: dict, effective_task_id: str, tool_call_id: Optional[str] = None) -> str:
            if function_name not in dynamic_names:
                return original_invoke(function_name, function_args, effective_task_id, tool_call_id)
            call_id = tool_call_id or f"call_{uuid.uuid4().hex[:12]}"
            coro = peer.request(
                "item/tool/call",
                {
                    "threadId": thread_id,
                    "turnId": effective_task_id or thread_id,
                    "callId": call_id,
                    "tool": function_name,
                    "arguments": function_args,
                },
                timeout=600,
            )
            future = asyncio.run_coroutine_threadsafe(coro, peer._loop)
            response = future.result(timeout=620)
            items = response.get("contentItems") if isinstance(response, dict) else []
            texts = []
            for item in items or []:
                if isinstance(item, dict) and item.get("type") == "inputText":
                    texts.append(str(item.get("text") or ""))
                elif isinstance(item, dict) and item.get("type") == "inputImage":
                    texts.append(str(item.get("imageUrl") or ""))
            return "\n".join(texts) if texts else json.dumps(response, ensure_ascii=False)

        agent._invoke_tool = invoke

    def _tool_progress_callback(self, thread_id: str):
        def callback(event: str, tool_name: str, preview: Any = None, args: Any = None, **kwargs: Any) -> None:
            loop = self.peer._loop
            if loop is None:
                return
            method = "item/tool/started" if event == "tool.started" else "item/tool/completed"
            asyncio.run_coroutine_threadsafe(
                self.peer.notify(
                    method,
                    {
                        "threadId": thread_id,
                        "turnId": thread_id,
                        "itemId": kwargs.get("toolCallId") or f"{tool_name}:{int(time.time() * 1000)}",
                        "tool": tool_name,
                        "preview": preview,
                        "arguments": args,
                        "duration": kwargs.get("duration"),
                        "isError": kwargs.get("is_error"),
                    },
                ),
                loop,
            )
        return callback

    def _thinking_callback(self, thread_id: str):
        def callback(text: str) -> None:
            if not text:
                return
            loop = self.peer._loop
            if loop is None:
                return
            asyncio.run_coroutine_threadsafe(
                self.peer.notify(
                    "item/reasoning/textDelta",
                    {
                        "threadId": thread_id,
                        "turnId": thread_id,
                        "itemId": "reasoning",
                        "delta": text,
                    },
                ),
                loop,
            )
        return callback


async def main_loop() -> None:
    _setup_logging()
    _load_env()
    server = HermesAppServer()
    loop = asyncio.get_running_loop()
    server.peer.bind_loop(loop)
    logger.info("Hermes OpenClaw app server started")

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("invalid json line: %s", line[:200])
            continue
        if server.peer.handle_response(message):
            continue
        if isinstance(message, dict) and "method" in message:
            await server.handle_request(message)


if __name__ == "__main__":
    asyncio.run(main_loop())
