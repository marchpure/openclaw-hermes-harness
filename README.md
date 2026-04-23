# openclaw-plugin-hermes

OpenClaw 插件 — 将 OpenClaw workspace 投影为 task-scoped execution workdir，并交给容器化的 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 执行。

> **OpenClaw 是大脑，Hermes 是手脚。**

## 概述

这个插件让 OpenClaw 可以把任务放到运行在 Docker 容器中的 Hermes Agent 上执行。当前实现不是把 OpenClaw host tool 直接带入 Hermes，而是先把 workspace 中可投影的上下文文件与本地 skills 物化到一个 task-scoped execution workdir，再通过 ACP (Agent Client Protocol) 让 Hermes 在这个 cwd 下执行。

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
| `hermesContainerName` | string | `hermes-agent` | Docker 容器名 |
| `hermesDataDir` | string | — | Hermes 数据目录 (宿主机路径) |
| `execEnvRootDir` | string | `<hermesDataDir>/execenv` | 宿主机上的 task-scoped execenv 根目录 |
| `runtimeExecEnvRootDir` | string | 同 `execEnvRootDir` | Hermes 运行时可见的 execenv 根目录 |
| `projectionVersion` | string | `c1c2-v1` | execution projection 版本号 |
| `defaultModel` | string | — | 默认 LLM 模型 |
| `defaultContextLevel` | L0-L3 | `L1` | 默认传递层级 |
| `defaultCredentialScope` | C0-C2 | `C0` | 默认凭据范围 |
| `defaultWriteback` | W0-W3 | `W1` | 默认回写策略 |
| `timeout` | number | `1800` | 超时秒数 |
| `autoStrategy` | boolean | `true` | 自动推断策略 |
| `enableLayeredProtocol` | boolean | `true` | 启用分层协议（L/C/W），关闭后直接派发任务 |
| `transport` | string | `tcp` | 当前实现只支持本地 Hermes ACP TCP bridge |
| `skillProjection.hostBackedDenylist` | string[] | `["browser","feishu"]` | 会被识别并过滤掉的 host-backed skill 名称 |
| `execEnvCleanup.maxCount` | number | `200` | 最多保留多少个历史 execenv 目录 |

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

## 架构

```
用户 ──► OpenClaw (网关 + 大脑)
              │
              ├── 轻量任务 → 直接执行 (内置工具)
              │
              └── 重型任务 → hermes_dispatch
                    │
                    ├── 策略推断 (strategy-engine)
                    ├── execution projection (runtime-client)
                    ├── 上下文发现/skills 过滤 (context-assembler + runtime-client)
                    ├── execenv 构建 (execenv-builder)
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

插件通过本地 ACP TCP bridge 与 Hermes 通信：

```
OpenClaw ──TCP──► 127.0.0.1:3100 (Hermes ACP bridge)
    │
    │  JSON-RPC
    │  ← initialize
    │  → session/new
    │  ← session_id
    │  → session/prompt
    │  ← streaming events
    │  ← done / terminal payload
    │  → session/close
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
    ├── runtime-client.ts     # execution projection 编排
    ├── strategy-engine.ts    # L/C/W 策略推断
    ├── context-assembler.ts  # 上下文组装 (L0-L3)
    ├── execenv-builder.ts    # task-scoped execenv 物化
    ├── runtime-paths.ts      # host/runtime 路径映射
    ├── credential-injector.ts # 凭据注入 (C0-C2)
    ├── result-processor.ts   # 结果处理 (W0-W3)
    ├── acp-client.ts         # ACP JSON-RPC 客户端
    └── health.ts             # 健康检查
```

## License

MIT
