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

详见 [plugin-design.md](hermes-containerized/docs/plugin-design.md)。

核心设计 — 三维传递协议：

| 维度 | 选项 | 说明 |
|------|------|------|
| **Context Level** | L0-L3 | 控制传递多少上下文给 Hermes |
| **Credential Scope** | C0-C2 | 控制传递哪些凭据给容器 |
| **Writeback** | W0-W3 | 控制执行结果回写策略 |

示例：

```
hermes_dispatch(
    task      = "帮我在 GitHub 上 fork 这个仓库",
    context   = L1,
    credential= C1(["GITHUB_TOKEN"]),
    writeback = W1
)
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
- **Docker** + Docker Compose
- **Playwright** — 浏览器自动化
- **ACP** — Agent Client Protocol (IDE 集成)
- **火山方舟 ARK** — MiniMax-M2.5 模型推理

## 许可证

Hermes Agent 源码遵循 MIT 许可证 — 详见 [src/LICENSE](hermes-containerized/src/LICENSE)。
容器化部署配置由本项目维护。
