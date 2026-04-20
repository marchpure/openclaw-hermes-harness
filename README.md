# ArkClaw Hermes

将 [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) 容器化部署，集成到ArkClaw中，并设计 OpenClaw 插件集成方案，使 OpenClaw 能够将重型任务委派给容器化的 Hermes Agent 执行。

## 项目概览

```
arkclaw-hermes/
├── hermes-containerized/        # Hermes Agent 容器化部署
│   ├── Dockerfile               # Debian 基础镜像构建 (国内源优化)
│   ├── Dockerfile.ubuntu        # Ubuntu 24.04 基础镜像构建 (国内源优化)
│   ├── docker-compose.yml       # Gateway 常驻模式编排
│   ├── docker-compose.acp.yml   # ACP TCP 双进程模式编排
│   ├── Makefile                 # 快捷命令
│   ├── .env.example             # 环境变量模板
│   ├── scripts/                 # 辅助脚本
│   │   ├── entrypoint-gateway.sh  # Gateway 模式入口
│   │   ├── entrypoint-acp.sh      # ACP TCP 模式入口
│   │   ├── acp-tcp-server.py      # TCP → ACP bridge 服务
│   │   ├── test-acp-tcp.py        # TCP 测试客户端
│   │   └── test-model.sh          # 模型连通性测试
│   ├── src/                     # Hermes Agent 源码 (git clone)
│   ├── data/                    # 持久化数据 (运行时生成)
│   └── docs/                    # 设计文档
│       ├── plugin-design.md     # OpenClaw × Hermes 插件集成方案
│       └── plugin-verification.md # 验证报告
├── openclaw-plugin-hermes/      # OpenClaw 插件 (TypeScript)
│   ├── src/                     # 插件源码
│   │   ├── index.ts             # 插件入口 (注册 4 个工具)
│   │   ├── types.ts             # 三维协议类型定义
│   │   ├── dispatcher.ts        # 任务调度器 (核心编排)
│   │   ├── strategy-engine.ts   # L/C/W 策略自动推断
│   │   ├── context-assembler.ts # 上下文组装 (L0-L3)
│   │   ├── credential-injector.ts # 凭据注入 (C0-C2)
│   │   ├── result-processor.ts  # 结果处理与回写 (W0-W3)
│   │   ├── acp-client.ts        # ACP JSON-RPC 客户端 (TCP + stdio)
│   │   ├── health.ts            # 容器健康检查
│   │   └── session-registry.ts  # 活跃会话追踪与取消
│   ├── openclaw.plugin.json     # 插件声明与配置 Schema
│   ├── package.json             # 依赖管理
│   ├── tsconfig.json            # TypeScript 配置
│   └── test-e2e.ts              # 端到端测试
└── .gitignore
```

## 核心特性

- **容器化部署** — 基于 Docker Compose 一键启动，国内镜像源加速构建
- **双运行模式** — Gateway 常驻模式 (消息平台网关) + ACP TCP 模式 (IDE/插件集成)
- **火山方舟集成** — 默认使用 MiniMax-M2.5 模型，OpenAI-compatible API 协议
- **OpenClaw 插件方案** — 三维传递协议 (Context Level × Credential Scope × Writeback)，50 场景验证
- **资源限制** — 可配置 CPU/内存限制，安全沙箱隔离

## 快速开始

### 1. 初始化项目

```bash
cd hermes-containerized
make setup
```

此命令会克隆 Hermes Agent 源码到 `src/`，创建 `data/` 目录，并从 `.env.example` 生成 `.env` 文件。

### 2. 配置环境变量

```bash
vim .env
```

必填项：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | 火山方舟 ARK API Key |
| `OPENAI_BASE_URL` | API 端点 (默认 `https://ark.cn-beijing.volces.com/api/coding/v3`) |

可选项：`OPENROUTER_API_KEY`、`GOOGLE_API_KEY`、`MINIMAX_API_KEY`

### 3. 构建与启动

```bash
make build    # 构建 Docker 镜像
make up       # 启动 Gateway 模式
```

或使用 ACP TCP 模式（推荐用于 IDE 集成）：

```bash
make up-acp   # 启动 ACP TCP 模式 (端口 3100)
```

### 4. 验证运行

```bash
make test     # 健康检查
make logs     # 查看日志
```

## 运行模式

### Gateway 模式

Hermes 作为消息平台网关常驻运行，支持 Telegram、Discord、Slack、WhatsApp、Signal 等平台。

```bash
make up       # 启动
make down     # 停止
make logs     # 查看日志
make shell    # 进入容器
```

### ACP TCP 模式

容器内同时运行 Hermes Gateway (后台) + ACP TCP Bridge (前台)，监听 TCP 3100 端口，支持 IDE 插件通过 JSON-RPC 协议通信。

```bash
make up-acp   # 启动
make down-acp # 停止
make logs-acp # 查看日志
make shell-acp # 进入容器
```

**通信协议**: Agent Client Protocol (ACP)，NDJSON 帧格式，每个 TCP 连接创建独立的 Agent 实例。

## 模型配置

默认使用火山方舟 ARK 端点的 MiniMax-M2.5 模型：

- **API Base**: `https://ark.cn-beijing.volces.com/api/coding/v3`
- **Model ID**: `minimax-m2.5`
- **协议**: OpenAI-compatible

首次启动后，编辑 `data/config.yaml` 修改模型配置：

```yaml
model:
  default: minimax-m2.5
```

## Docker 构建说明

提供两个 Dockerfile：

| 文件 | 基础镜像 | 适用场景 |
|------|---------|---------|
| `Dockerfile` | Debian 13 (trixie) | 通用，体积较小 |
| `Dockerfile.ubuntu` | Ubuntu 24.04 | 兼容性更好，Node.js 20 |

两个镜像均配置了：
- 清华大学 APT/PIP/NPM 镜像源加速
- uv 包管理器 + Python 3.13
- Playwright 浏览器自动化
- 非 root 用户运行
- 代理构建支持 (`--build-arg http_proxy=...`)

## OpenClaw 插件集成

> **OpenClaw 是大脑，Hermes 是手脚。**

`openclaw-plugin-hermes/` 是一个 OpenClaw 插件，让 OpenClaw 可以把需要终端、浏览器、代码执行等重型能力的任务委派给运行在 Docker 容器中的 Hermes Agent。通过 ACP (Agent Client Protocol) 通信，Hermes 在隔离的容器环境中执行任务，结果回传给 OpenClaw。

详细设计文档：[plugin-design.md](hermes-containerized/docs/plugin-design.md)

### 核心设计：三维传递协议

每次任务委派沿三个正交维度控制 **"传什么"**、**"给什么权限"**、**"回写什么"**：

| 维度 | 选项 | 说明 |
|------|------|------|
| **Context Level** | L0-L3 | 控制传递多少上下文给 Hermes |
| **Credential Scope** | C0-C2 | 控制传递哪些凭据给容器 |
| **Writeback** | W0-W3 | 控制执行结果回写策略 |

**传递层级 (Context Level)：**

| Level | 名称 | 传递内容 | Token 开销 |
|-------|------|---------|-----------|
| L0 | Stateless | 指令 + 模型配置 | < 200 |
| L1 | Tools | + 工具配置 + 命令白名单 + 浏览器配置 | < 500 |
| L2 | Context | + 自适应记忆 + 身份 (SOUL/USER) + AGENTS.md | 500 - 4K |
| L3 | Full Sync | + 技能文件 + MCP 定义 + cron 定义 | 2K - 8K |

**凭据范围 (Credential Scope)：**

| Scope | 名称 | 传递内容 |
|-------|------|---------|
| C0 | None | 不传任何凭据 |
| C1 | Specified | 只传指定凭据 (如 `GITHUB_TOKEN`) |
| C2 | All | 传所有凭据 — 仅用户明确授权时使用 |

**回写策略 (Writeback)：**

| Write | 名称 | 回写内容 |
|-------|------|---------|
| W0 | None | 不回写 (纯查询) |
| W1 | Result | 只回写执行结果文本 |
| W2 | Memory | 回写结果 + 更新 OpenClaw 记忆 |
| W3 | Full | 回写技能 / cron 定义 / 配置变更 (需用户确认) |

### 注册的工具

插件注册了 4 个工具供 OpenClaw 调用：

#### `hermes_dispatch`

将任务委派给 Hermes 执行。支持自动策略推断和显式参数覆盖。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | ✅ | 任务描述 (自然语言) |
| `contextLevel` | L0-L3 | ❌ | 覆盖上下文层级，省略则自动推断 |
| `credentialScope` | C0-C2 | ❌ | 覆盖凭据范围，省略则自动推断 |
| `credentialKeys` | string[] | ❌ | C1 模式下指定凭据键 (如 `["GITHUB_TOKEN"]`) |
| `writeback` | W0-W3 | ❌ | 覆盖回写策略，省略则自动推断 |
| `model` | string | ❌ | 覆盖 LLM 模型 |
| `timeout` | number | ❌ | 超时秒数 (默认 1800) |
| `enableLayeredProtocol` | boolean | ❌ | 单次调用覆盖分层协议开关 |

**示例：**

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
hermes_dispatch({ task: "用我的语气帮我写一封邮件回复", contextLevel: "L2" })
→ 自动推断: L2/C0/W1 (传递 SOUL.md + USER.md + 记忆)
```

#### `hermes_status`

检查 Hermes 容器的健康状态。返回容器运行状态、ACP 响应性、版本号、资源使用情况。

#### `hermes_strategy`

预览自动推断的策略 (不执行)。用于了解某个任务会使用什么上下文、凭据和回写策略。

```
hermes_strategy({ task: "创建一个 GitHub Actions CI 技能" })
→ Strategy: L3/C1(GITHUB_TOKEN)/W3
  Confidence: 80%
  Reasoning: Task involves skill/MCP/cron management; Task needs credentials for: github; Task creates skills, cron jobs, or config changes
```

#### `hermes_cancel`

取消正在运行的 Hermes 任务。无参数时取消所有活跃任务，指定 `dispatchId` 时取消特定任务。

### 策略自动推断

策略引擎 (`strategy-engine.ts`) 通过关键词匹配自动推断最优 L/C/W 三元组：

- **L 推断**：检测到 "上次/记得/习惯" → L2；检测到 "skill/cron/MCP" → L3；检测到 "运行/浏览器/文件" → L1；否则 → L0
- **C 推断**：检测到 "github" → C1(`GITHUB_TOKEN`)；检测到 "telegram" → C1(`TELEGRAM_BOT_TOKEN`)；检测到 "跨平台/所有通道" → C2；否则 → C0
- **W 推断**：检测到 "创建skill/设置定时" → W3；检测到 "记住/部署" → W2；检测到 "查/看/搜" → W0；否则 → W1
- **交叉校验**：W3 时自动提升至 L2+；C2 时自动提升至 L2+

### 通信架构

插件支持两种 ACP 传输方式：

| 传输方式 | 连接方式 | 启动延迟 | 并发支持 | 推荐场景 |
|---------|---------|---------|---------|---------|
| **TCP** (推荐) | 连接 `127.0.0.1:3100` | ~0ms | 多连接多会话 | 生产环境 |
| **stdio** | `docker exec hermes-agent hermes acp` | ~2-3s | 单会话 | 调试/备选 |

两种传输使用完全相同的 JSON-RPC 协议和 NDJSON 帧格式。

```
OpenClaw ──TCP/stdio──► Hermes Container
    │                        │
    │  JSON-RPC (ACP)        │
    │  → initialize          │
    │  ← capabilities        │
    │  → session/new         │
    │  ← sessionId           │
    │  → session/prompt      │
    │  ← streaming events    │
    │  ← done                │
    │  → session/cancel      │  (通知，无响应)
    │  → session/close       │
```

### 插件安装

```bash
# 从 ClawHub 安装
openclaw plugins install clawhub:openclaw-plugin-hermes

# 或从源码
cd openclaw-plugin-hermes
npm install
```

**前置条件：**

1. Hermes Agent 容器已构建并运行 (`make build && make up-acp`)
2. Docker 可用且当前用户有权限执行 `docker exec`
3. OpenClaw 网关已运行

### 插件配置

在 OpenClaw 配置中添加：

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-hermes": {
        "enabled": true,
        "config": {
          "hermesContainerName": "hermes-agent",
          "defaultModel": "minimax-m2.5",
          "transport": "tcp",
          "tcpHost": "127.0.0.1",
          "tcpPort": 3100,
          "autoStrategy": true,
          "enableLayeredProtocol": true,
          "timeout": 1800
        }
      }
    }
  }
}
```

**配置项：**

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `hermesCommand` | string | `docker exec -i hermes-agent hermes acp` | 自定义 hermes-acp 启动命令 |
| `hermesContainerName` | string | `hermes-agent` | Docker 容器名 |
| `hermesDataDir` | string | — | Hermes 数据目录 (宿主机路径) |
| `defaultModel` | string | — | 默认 LLM 模型 |
| `defaultContextLevel` | L0-L3 | `L1` | 默认传递层级 |
| `defaultCredentialScope` | C0-C2 | `C0` | 默认凭据范围 |
| `defaultWriteback` | W0-W3 | `W1` | 默认回写策略 |
| `transport` | tcp/stdio | `tcp` | 传输模式 |
| `tcpHost` | string | `127.0.0.1` | TCP 主机 |
| `tcpPort` | number | `3100` | TCP 端口 |
| `timeout` | number | `1800` | 超时秒数 |
| `autoStrategy` | boolean | `true` | 自动推断策略 |
| `enableLayeredProtocol` | boolean | `true` | 启用分层协议，关闭后直接派发 |

### 任务调度流水线

```
OpenClaw 收到任务
    │
    ▼
策略推断引擎 → 确定 L/C/W 三元组
    │
    ▼
上下文组装器 (context-assembler)
    ├── L0: { task, model_config }
    ├── L1: + { tool_config, command_allowlist, browser_config }
    ├── L2: + { memory, identity (SOUL/USER), agents_md }
    └── L3: + { skills, mcp_servers, cron_definitions }
    │
    ▼
凭据注入器 (credential-injector) → C0/C1/C2 注入环境变量
    │
    ▼
ACP 客户端 (acp-client) → TCP/stdio 连接 Hermes 容器
    │
    ▼
结果处理器 (result-processor) → W0/W1/W2/W3 选择性回写
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `make setup` | 初始化项目 (克隆源码 + 准备配置) |
| `make build` | 构建 Docker 镜像 |
| `make up` | 启动 Gateway 模式 (后台) |
| `make up-acp` | 启动 ACP TCP 模式 (后台) |
| `make down` | 停止 Gateway 模式 |
| `make down-acp` | 停止 ACP TCP 模式 |
| `make logs` | 查看 Gateway 日志 |
| `make logs-acp` | 查看 ACP 日志 |
| `make shell` | 进入容器 (Gateway) |
| `make shell-acp` | 进入容器 (ACP) |
| `make test` | 运行健康检查 |
| `make clean` | 清理镜像和数据 |
| `make help` | 显示所有命令 |

## 安全设计

- 容器以 `no-new-privileges` 安全选项运行
- 非 root 用户执行 Python 应用
- 可配置 CPU/内存资源限制
- ACP TCP 端口建议绑定 `127.0.0.1`，不对外暴露
- 凭据通过环境变量注入，不持久化到磁盘

## 技术栈

- **Hermes Agent** v0.9.0 — Nous Research 自改进 AI Agent
- **Python** 3.13 + uv 包管理器
- **TypeScript** — OpenClaw 插件开发
- **Docker** + Docker Compose
- **Playwright** — 浏览器自动化
- **ACP** — Agent Client Protocol (IDE/插件集成)
- **火山方舟 ARK** — MiniMax-M2.5 模型推理

## 许可证

Hermes Agent 源码遵循 MIT 许可证 — 详见 [src/LICENSE](hermes-containerized/src/LICENSE)。
容器化部署配置由本项目维护。
