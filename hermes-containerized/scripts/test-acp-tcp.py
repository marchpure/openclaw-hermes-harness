#!/usr/bin/env python3
"""ACP TCP Client — Test Hermes ACP over TCP.

Connects to the ACP TCP bridge and runs the same test sequence:
  initialize → session/new → session/prompt

The ACP connection uses NDJSON (newline-delimited JSON) framing.

Usage:
    python test-acp-tcp.py [--host HOST] [--port PORT] [--prompt TEXT]
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

HOST = "127.0.0.1"
PORT = 3100
MSG_ID = 0


def next_id():
    global MSG_ID
    MSG_ID += 1
    return MSG_ID


async def read_message(reader):
    """Read one NDJSON message (one JSON object per line)."""
    line = await reader.readline()
    if not line:
        return None
    line_str = line.decode("utf-8").strip()
    if not line_str:
        return None
    return json.loads(line_str)


async def read_until_response(reader, expected_id, timeout=60.0):
    """Read messages until we get a response matching expected_id."""
    notifications = []
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            msg = await asyncio.wait_for(read_message(reader), timeout=max(remaining, 1.0))
        except asyncio.TimeoutError:
            break

        if msg is None:
            break

        if "id" in msg and msg["id"] == expected_id:
            return msg, notifications
        else:
            notifications.append(msg)

    return None, notifications


def send_request(writer, method, params=None):
    """Build and write a JSON-RPC request as NDJSON. Returns the request id."""
    req_id = next_id()
    msg = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
    }
    if params is not None:
        msg["params"] = params
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    writer.write(line.encode("utf-8"))
    return req_id


def print_section(title):
    print("\n" + "=" * 60)
    print("  " + title)
    print("=" * 60)


def print_json(label, data):
    print("\n{}:".format(label))
    print(json.dumps(data, indent=2, ensure_ascii=False))


async def run_test(host, port, prompt_text):
    print_section("ACP TCP Client Test")
    print("Connecting to {}:{}...".format(host, port))

    try:
        reader, writer = await asyncio.open_connection(host, port)
    except (ConnectionRefusedError, OSError) as e:
        print("❌ Connection failed: {}".format(e))
        return False

    print("✅ Connected\n")
    success = True

    # ── Step 1: Initialize ──
    print_section("Step 1: initialize")
    req_id = send_request(writer, "initialize", {
        "protocolVersion": 1,
        "clientInfo": {"name": "test-acp-tcp", "version": "1.0.0"},
        "clientCapabilities": {}
    })
    await writer.drain()

    resp, notifs = await read_until_response(reader, req_id, timeout=30)
    if resp and "result" in resp:
        result = resp["result"]
        agent_info = result.get("agentInfo", {})
        print("✅ initialize OK")
        print("   Agent: {} v{}".format(agent_info.get("name", "?"), agent_info.get("version", "?")))
        print("   Protocol: v{}".format(result.get("protocolVersion", "?")))
    else:
        print("❌ initialize FAILED")
        print_json("Response", resp or {"error": "timeout"})
        success = False

    # ── Step 2: session/new ──
    print_section("Step 2: session/new")
    req_id = send_request(writer, "session/new", {
        "cwd": "/opt/data",
        "mcpServers": []
    })
    await writer.drain()

    resp, notifs = await read_until_response(reader, req_id, timeout=30)
    session_id = None
    if resp and "result" in resp:
        session_id = resp["result"].get("sessionId")
        print("✅ session/new OK")
        print("   Session ID: {}".format(session_id))
        for n in notifs:
            update = n.get("params", {}).get("update", {})
            print("   Notification: {}".format(update.get("sessionUpdate", "unknown")))
    else:
        print("❌ session/new FAILED")
        print_json("Response", resp or {"error": "timeout"})
        success = False

    if not session_id:
        print("⚠️  No session ID, skipping prompt test")
        writer.close()
        return False

    # ── Step 3: session/prompt ──
    print_section('Step 3: session/prompt ("{}")'.format(prompt_text))
    req_id = send_request(writer, "session/prompt", {
        "sessionId": session_id,
        "prompt": [
            {"type": "text", "text": prompt_text}
        ]
    })
    await writer.drain()

    print("   Waiting for response (streaming)...")
    resp, notifs = await read_until_response(reader, req_id, timeout=120)

    collected_text = []
    for n in notifs:
        update = n.get("params", {}).get("update", {})
        update_type = update.get("sessionUpdate", "")
        if update_type == "agent_message_chunk":
            text = update.get("content", {}).get("text", "")
            if text:
                collected_text.append(text)
                display = text[:100] + ("..." if len(text) > 100 else "")
                print("   📝 chunk: {}".format(display))
        elif update_type == "agent_thought_chunk":
            text = update.get("content", {}).get("text", "")
            if text:
                display = text[:80] + ("..." if len(text) > 80 else "")
                print("   🧠 thought: {}".format(display))
        else:
            print("   📨 {}".format(update_type))

    if resp and "result" in resp:
        result = resp["result"]
        stop_reason = result.get("stopReason", "?")
        usage = result.get("usage", {})
        print("\n✅ session/prompt OK")
        print("   Stop reason: {}".format(stop_reason))
        if usage:
            print("   Usage: input={}, output={}, total={}".format(
                usage.get("inputTokens", 0),
                usage.get("outputTokens", 0),
                usage.get("totalTokens", 0),
            ))
        full_response = "".join(collected_text)
        if full_response:
            display = full_response[:200] + ("..." if len(full_response) > 200 else "")
            print("   Full response: {}".format(display))
    else:
        print("❌ session/prompt FAILED")
        print_json("Response", resp or {"error": "timeout"})
        success = False

    # ── Cleanup ──
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:
        pass

    print_section("Result")
    if success:
        print("✅ All tests passed — ACP over TCP works!")
    else:
        print("❌ Some tests failed")

    return success


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Test ACP TCP bridge")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--prompt", default="回复两个字")
    args = parser.parse_args()

    ok = asyncio.run(run_test(args.host, args.port, args.prompt))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
