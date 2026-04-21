# openclaw-plugin-hermes

OpenClaw 插件 — 将重型任务委派给容器化的 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 执行。

> **OpenClaw 是大脑，Hermes 是手脚。**

## 概述

这个插件让 OpenClaw 可以把需要终端、浏览器、代码执行等重型能力的任务委派给运行在 Docker 容器中的 Hermes Agent。通过 ACP (Agent Client Protocol) 通信，Hermes 在隔离的容器环境中执行任务，结果回传给 OpenClaw。

除了保留 `hermes_dispatch` 工具式委派，这个插件也支持被安装脚本配置为 **OpenClaw ACP agent alias**：

- `/acp spawn hermes --bind here`
- `/acp spawn hermes --thread auto`
- `sessions_spawn({ runtime: "acp", agentId: "hermes" })`

这部分能力依赖：

- OpenClaw 自带 `acpx` ACP backend 插件
- `~/.acpx/config.json` 中存在 `agents.hermes.command`
- `openclaw.json` 中启用 ACP、允许 `hermes` agent、并打开支持的 channel thread binding

### 核心设计：三维传递协议

每次任务委派沿三个正交维度控制：

| 维度 | 说明 | 级别 |
|------|------|------|
| **传递层级** (Context Level) | Hermes 知道多少 | L0 (纯指令) → L3 (全量同步) |
| **凭据范围** (Credential Scope) | Hermes 能访问什么服务 | C0 (无) → C2 (全部) |
| **回写策略** (Writeback) | 什么结果写回 OpenClaw | W0 (不回写) → W3 (技能/定时任务) |

## 安装

```bash
# 从 ClawHub 安装
openclaw plugins install clawhub:openclaw-plugin-hermes

# 或从源码
cd openclaw-plugin-hermes
npm install
```

## 前置条件

1. **Hermes Agent 容器** 已构建并运行：
  检查 hermes-agent 容器是否已运行，如果已运行并且成功透出3100端口，无需重复构建。
  如果 容器存在但未运行，或端口未成功透出，执行以下命令：
   ```bash
   make build
   make up
   ```

2. **Docker** 可用且当前用户有权限执行 `docker exec`

3. **OpenClaw** 网关已运行

## 配置

在 OpenClaw 配置中添加：

```json
{
  "plugins": {
    "entries": {
      "hermes": {
        "enabled": true,
        "config": {
          "hermesContainerName": "hermes-agent",
          "defaultModel": "minimax-m2.5",
          "autoStrategy": true,
          "enableLayeredProtocol": false,
          "timeout": 1800
        }
      }
    }
  }
}
```

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `hermesCommand` | string | `docker exec -i hermes-agent hermes acp` | 自定义 hermes-acp 启动命令 |
| `hermesContainerName` | string | `hermes-agent` | Docker 容器名 |
| `hermesDataDir` | string | — | Hermes 数据目录 (宿主机路径) |
| `defaultModel` | string | — | 默认 LLM 模型 |
| `defaultContextLevel` | L0-L3 | `L1` | 默认传递层级 |
| `defaultCredentialScope` | C0-C2 | `C0` | 默认凭据范围 |
| `defaultWriteback` | W0-W3 | `W1` | 默认回写策略 |
| `timeout` | number | `1800` | 超时秒数 |
| `autoStrategy` | boolean | `true` | 自动推断策略 |
| `enableLayeredProtocol` | boolean | `true` | 启用分层协议（L/C/W），关闭后直接派发任务 |

## 注册的工具

### `hermes_dispatch`

将任务委派给 Hermes 执行。

**参数:**
- `task` (string, 必填) — 任务描述
- `contextLevel` (L0-L3, 可选) — 覆盖上下文层级
- `credentialScope` (C0-C2, 可选) — 覆盖凭据范围
- `credentialKeys` (string[], 可选) — C1 模式下指定凭据键
- `writeback` (W0-W3, 可选) — 覆盖回写策略
- `model` (string, 可选) — 覆盖 LLM 模型
- `timeout` (number, 可选) — 超时秒数
- `enableLayeredProtocol` (boolean, 可选) — 单次调用覆盖分层协议开关，false 时直接派发

**示例:**
```
// 自动策略 — 插件根据任务文本自动推断 L/C/W
hermes_dispatch({ task: "检查服务器磁盘空间" })
→ 自动推断: L1/C0/W1

// 显式策略
hermes_dispatch({
  task: "帮我在 GitHub 上 fork 这个仓库",
  contextLevel: "L1",
  credentialScope: "C1",
  credentialKeys: ["GITHUB_TOKEN"],
  writeback: "W1"
})

// 需要记忆上下文
hermes_dispatch({
  task: "用我的语气帮我写一封邮件回复",
  contextLevel: "L2"
})
→ 自动推断: L2/C0/W1 (传递 SOUL.md + USER.md + 记忆)
```

### `hermes_status`

检查 Hermes 容器的健康状态。

**返回:** 容器运行状态、ACP 响应性、版本号、资源使用情况

### `hermes_strategy`

预览自动推断的策略（不执行）。

**参数:**
- `task` (string, 必填) — 要分析的任务

**示例:**
```
hermes_strategy({ task: "创建一个 GitHub Actions CI 技能" })
→ Strategy: L3/C1(GITHUB_TOKEN)/W3
  Confidence: 80%
  Reasoning: Task involves skill/MCP/cron management; Task needs credentials for: github; Task creates skills, cron jobs, or config changes
```

### `hermes_acp_agent`

输出 Hermes 作为 ACP agent alias 时需要的配置片段和当前状态检查，包括：

- 当前 alias
- 当前 command
- `~/.acpx/config.json` 片段
- `openclaw.json` 片段
- 是否已检测到 alias 已被写入

## 架构

```
用户 ──► OpenClaw (网关 + 大脑)
              │
              ├── 轻量任务 → 直接执行 (内置工具)
              │
              └── 重型任务 → hermes_dispatch
                    │
                    ├── 策略推断 (strategy-engine)
                    ├── 上下文组装 (context-assembler)
                    ├── 凭据注入 (credential-injector)
                    ├── ACP 通信 (acp-client)
                    └── 结果处理 (result-processor)
                          │
                          ▼
                    Hermes Container (Docker)
                    ├── Terminal / SSH
                    ├── Browser (Playwright)
                    ├── Code Execution
                    ├── Sub-agent Delegation
                    └── Skills System
```

## 通信协议

插件通过 ACP (Agent Client Protocol) 与 Hermes 通信：

```
OpenClaw ──stdio──► docker exec hermes-agent hermes acp
    │                     │
    │  JSON-RPC           │
    │  ← initialize       │
    │  → new_session      │
    │  ← session_id       │
    │  → prompt           │
    │  ← streaming events │
    │  ← done             │
    │  → close            │
```

## 安全

- **凭据隔离**: 凭据通过环境变量注入，不写磁盘，每次注入有审计日志
- **容器沙箱**: Hermes 在 Docker 容器中运行，read-only filesystem, no-new-privileges
- **最小权限**: C0 (默认无凭据) → C1 (指定凭据) → C2 (全部，需确认)
- **回写控制**: W3 级别的技能/cron 创建需要用户确认

## 文件结构

```
openclaw-plugin-hermes/
├── package.json
├── openclaw.plugin.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts              # 插件入口 (注册工具)
    ├── types.ts              # 类型定义
    ├── dispatcher.ts         # 任务调度器 (核心)
    ├── strategy-engine.ts    # L/C/W 策略推断
    ├── context-assembler.ts  # 上下文组装 (L0-L3)
    ├── credential-injector.ts # 凭据注入 (C0-C2)
    ├── result-processor.ts   # 结果处理 (W0-W3)
    ├── acp-client.ts         # ACP JSON-RPC 客户端
    └── health.ts             # 健康检查
```

## License

MIT
