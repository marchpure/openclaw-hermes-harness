# OpenClaw × Hermes 插件验证报告

**日期**: 2026-04-15 (v1.1 更新)
**版本**: v1.1

## 1. 验证环境

| 组件 | 版本 | 状态 |
|------|------|------|
| Hermes Agent | v0.8.0 (2026.4.8) | ✅ 容器运行中 |
| Docker | 28.5.1 (Colima) | ✅ |
| OpenClaw | 2026.3.30 | ✅ 源码可用 |
| Node.js | v25.1.0 | ✅ |
| Python | 3.13.5 (容器内) | ✅ |
| ACP SDK | agent-client-protocol | ✅ |
| TypeScript | 5.x | ✅ 零编译错误 |

## 2. ACP 通信验证

### 2.1 协议方法名确认

通过查看 Hermes ACP adapter 源码 (`acp_adapter/server.py`) 和 ACP SDK (`AGENT_METHODS`)，确认实际方法名：

| 原设计假设 | 实际 ACP 方法名 | 状态 |
|------------|-----------------|------|
| `initialize` | `initialize` | ✅ 一致 |
| `new_session` | `session/new` | ❌ 已修正 |
| `prompt` | `session/prompt` | ❌ 已修正 |
| `cancel` | `session/cancel` | ❌ 已修正 |
| `close_session` | `session/close` | ❌ 已修正 |

### 2.2 参数格式确认

`session/new` 必须包含 `mcpServers` 参数（即使为空数组）：
```json
{"method": "session/new", "params": {"cwd": "/opt/data", "mcpServers": []}}
```

`session/prompt` 使用 `sessionId`（camelCase），不是 `session_id`：
```json
{"method": "session/prompt", "params": {"sessionId": "xxx", "prompt": [{"type": "text", "text": "..."}]}}
```

### 2.3 Streaming Event 格式

Hermes 通过 JSON-RPC notification 发送 session updates：
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {"text": "收到", "type": "text"}
    }
  }
}
```

事件类型映射：
| sessionUpdate 值 | 含义 |
|-------------------|------|
| `agent_message_chunk` | 文本回复片段 |
| `agent_thought_chunk` | 思考过程片段 |
| `available_commands_update` | 可用命令列表 |
| `tool_call_begin` | 工具调用开始 |
| `tool_call_end` | 工具调用结束 |

**注意**: 文本内容包裹在 `content.text` 中，不是直接 `text` 字段。

### 2.4 端到端测试结果 (v1.0 — stdio 方式)

```
→ initialize                    ← agentInfo: hermes-agent v0.8.0  ✅
→ session/new                   ← sessionId: 37a52f91-...         ✅
  (notification)                ← available_commands_update        ✅
→ session/prompt("回复两个字")  ← agent_thought_chunk             ✅
                                ← agent_message_chunk: "收到"      ✅
                                ← PromptResponse(end_turn)         ✅
                                   usage: 14903 tokens             ✅
```

### 2.5 端到端测试结果 (v1.1 — TCP 常驻进程方式)

```
→ TCP connect 127.0.0.1:3100                                      ✅
→ initialize                    ← agentInfo: hermes-agent v0.8.0  ✅
                                   Protocol: v1                    ✅
→ session/new                   ← sessionId: 2e8f569e-...         ✅
→ session/prompt("回复两个字")  ← available_commands_update        ✅
                                ← agent_thought_chunk              ✅
                                ← agent_message_chunk: "好的"      ✅
                                ← PromptResponse(end_turn)         ✅
                                   usage: 14834/23/14857 tokens    ✅
```

## 3. 容器化验证

### 3.1 启动命令修正

原始 `docker-compose.yml` 使用 `gateway start`，在 Docker 内部不适用。
修正为 `gateway run`（前台运行模式）。

### 3.2 hermes 可执行文件

容器内 hermes 不在 PATH 中，需要先激活 venv：
```bash
docker exec -i hermes-agent bash -c "source /opt/hermes/.venv/bin/activate && hermes acp"
```

插件中 `buildSpawnCommand()` 已包含此逻辑。

### 3.3 ACP TCP 常驻进程方式 (v1.1 新增)

#### 3.3.1 架构

原始方案通过 `docker exec` + stdio 管道与容器内 ACP 通信，每次任务都要 spawn 一个新进程。
v1.1 新增 **ACP TCP Bridge** 方案：容器内运行一个常驻 TCP 服务，暴露 ACP JSON-RPC 协议到端口 3100。

```
┌────────────────────┐          TCP :3100           ┌──────────────────────┐
│  OpenClaw Plugin   │  ←── NDJSON JSON-RPC ───→    │  hermes-acp 容器     │
│  (宿主机)           │                              │  acp-tcp-server.py   │
│                    │                              │  → HermesACPAgent    │
└────────────────────┘                              └──────────────────────┘
```

**优势 vs stdio 方式:**

| 对比项 | stdio (`docker exec`) | TCP (常驻进程) |
|--------|----------------------|---------------|
| 启动延迟 | 每次 ~2-3s (进程创建) | 首次连接后 ~0ms |
| 并发支持 | 单会话 | 多 TCP 连接 → 多会话 |
| 连接管理 | 进程生命周期绑定 | 独立 TCP 连接 |
| 复杂度 | 简单 | 稍复杂 (需 bridge) |
| 健康检查 | 需 exec | TCP connect 即可 |

#### 3.3.2 协议细节

- **传输层**: TCP, 默认端口 3100
- **消息帧格式**: NDJSON (Newline-Delimited JSON) — 每条 JSON-RPC 消息以 `\n` 结尾
- **协议**: 完全兼容 ACP JSON-RPC (与 stdio 方式相同的方法和参数)
- **并发**: 每个 TCP 连接创建独立的 `HermesACPAgent` 实例

**注意**: ACP SDK 不使用 Content-Length 头部帧格式，而是使用 NDJSON。这是一个关键发现。

#### 3.3.3 文件清单

| 文件 | 功能 |
|------|------|
| `scripts/acp-tcp-server.py` | TCP → ACP bridge 服务 |
| `scripts/entrypoint-acp.sh` | 容器入口 (初始化 + 启动 bridge) |
| `scripts/test-acp-tcp.py` | TCP 方式测试客户端 |
| `docker-compose.acp.yml` | ACP TCP 模式的 compose 配置 |

#### 3.3.4 启动方式

```bash
# 使用 ACP TCP compose 启动
docker compose -f docker-compose.acp.yml up -d

# 查看日志确认监听
docker logs hermes-acp
# → ACP TCP server listening on ('0.0.0.0', 3100)

# 运行测试
python3 scripts/test-acp-tcp.py --host 127.0.0.1 --port 3100
```

#### 3.3.5 docker-compose.acp.yml 关键配置

```yaml
services:
  hermes-acp:
    volumes:
      - ./scripts/entrypoint-acp.sh:/opt/hermes/docker/entrypoint-acp.sh:ro
      - ./scripts/acp-tcp-server.py:/opt/hermes/acp-tcp-server.py:ro
    entrypoint: ["/opt/hermes/docker/entrypoint-acp.sh"]
    ports:
      - "3100:3100"
    environment:
      - ACP_TCP_PORT=3100
      - ACP_TCP_HOST=0.0.0.0
```

#### 3.3.6 插件对接改动

使用 TCP 方式后，OpenClaw 插件的 `acp-client.ts` 需要修改通信层：

| 项目 | stdio 方式 | TCP 方式 |
|------|-----------|---------|
| 连接 | `child_process.spawn("docker", ["exec", ...])` | `net.createConnection({host, port})` |
| 读取 | `process.stdout` readline | TCP socket readline |
| 写入 | `process.stdin.write(json + "\n")` | `socket.write(json + "\n")` |
| 帧格式 | NDJSON | NDJSON (完全相同) |
| 断线重连 | 重新 exec | TCP reconnect |

## 4. 插件代码验证

### 4.1 TypeScript 编译

```
$ npx tsc --noEmit
(zero errors)
```

全部 9 个源文件（2355 行代码）类型检查通过。

### 4.2 模块依赖

| 模块 | 行数 | 功能 | 状态 |
|------|------|------|------|
| `types.ts` | 273 | 类型定义 | ✅ |
| `acp-client.ts` | 468 | ACP JSON-RPC 客户端 | ✅ 已修正方法名 |
| `strategy-engine.ts` | 215 | 策略自动推断 | ✅ |
| `context-assembler.ts` | 274 | 上下文组装 (L0-L3) | ✅ |
| `credential-injector.ts` | 179 | 凭据注入 (C0-C2) | ✅ |
| `result-processor.ts` | 315 | 结果处理 (W0-W3) | ✅ |
| `dispatcher.ts` | 225 | 核心调度器 | ✅ |
| `health.ts` | 173 | 健康检查 | ✅ |
| `index.ts` | 245 | 插件入口 | ✅ |

### 4.3 插件注册的工具

| 工具名 | 参数 | 功能 |
|--------|------|------|
| `hermes_dispatch` | task, contextLevel, credentialScope, credentialKeys, writeback, model, timeout | 委派任务到 Hermes |
| `hermes_status` | (无) | 检查容器健康 |
| `hermes_strategy` | task | 预览策略推断结果 |

## 5. 设计文档修订记录

| 修订项 | 原设计 | 修正后 | 原因 |
|--------|--------|--------|------|
| ACP 方法名 | `new_session`, `prompt` | `session/new`, `session/prompt` | ACP 协议使用命名空间格式 |
| Session ID 参数 | `session_id` | `sessionId` (camelCase) | Hermes ACP 适配器使用 camelCase |
| `session/new` 参数 | `{cwd}` | `{cwd, mcpServers: []}` | mcpServers 是必填参数 |
| 事件文本位置 | `data.text` | `data.content.text` | Hermes 把文本包裹在 content 对象中 |
| 事件类型名 | `agent_message_text` | `agent_message_chunk` | 实际用 chunk 后缀 |
| Docker 命令 | `gateway start` | `gateway run` | Docker 容器内需前台运行 |
| hermes 调用 | `docker exec hermes acp` | `bash -c "source .venv/bin/activate && hermes acp"` | hermes 不在 PATH |
| **通信方式** (v1.1) | **stdio (docker exec)** | **TCP :3100 (常驻进程)** | **更低延迟、支持并发、更易健康检查** |
| **帧格式** (v1.1) | — | **NDJSON (非 Content-Length)** | **ACP SDK 使用 newline-delimited JSON** |

## 6. 总结

### v1.0 成果

插件代码已完成全部 9 个模块，TypeScript 编译零错误。ACP 端到端通信已验证通过：
- 初始化 → 会话创建 → 提示发送 → 流式事件接收 → 响应收集，全链路畅通。
- 设计文档中 6 处与实际实现不符的地方已修正。
- Hermes 容器（v0.8.0）稳定运行，可通过 ACP stdio 正常交互。

### v1.1 新增 — ACP TCP 常驻进程方案

- ✅ 实现 `acp-tcp-server.py` — TCP → ACP bridge，监听端口 3100
- ✅ 实现 `entrypoint-acp.sh` — 容器入口脚本
- ✅ 实现 `docker-compose.acp.yml` — 独立的 ACP TCP compose 配置
- ✅ 实现 `test-acp-tcp.py` — TCP 方式测试客户端
- ✅ **端到端验证通过**: initialize → session/new → session/prompt 全链路 TCP 通信成功
- ✅ 发现关键协议细节: ACP 使用 **NDJSON 帧格式** (非 Content-Length)
- ✅ 容器以常驻进程方式运行，无需每次 `docker exec`

### 推荐方案

生产环境推荐使用 **TCP 常驻进程方案**:
- 省去每次 `docker exec` 的进程创建开销 (~2-3s)
- 天然支持多连接并发
- TCP connect 即可做健康检查
- 协议完全兼容，插件只需改通信层
