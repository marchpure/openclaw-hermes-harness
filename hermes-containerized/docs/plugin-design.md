# OpenClaw × Hermes 插件集成方案

::: subtitle
三维传递协议 · 50 场景验证 · 完整 API 设计  |  v1.1  |  2026-04-15
:::

## 1. 项目概述

### 1.1 目标

设计并实现一个 OpenClaw 插件，使 OpenClaw 能够将任务委派给容器化的
Hermes Agent 执行。Hermes 作为 OpenClaw
的"执行引擎"，提供独立的终端、浏览器、代码执行等重型能力，而 OpenClaw
保持轻量网关角色。

### 1.2 核心原则

- **OpenClaw 是大脑，Hermes 是手脚** — OpenClaw 做决策和调度，Hermes 做执行
- **按需传递，最小权限** — 每次任务只传递必要的上下文和凭据
- **结果可回写** — Hermes 的执行结果可以选择性地写回 OpenClaw 的记忆/技能
- **容器隔离** — Hermes 运行在容器中，天然安全边界

### 1.3 系统定位

```
用户 ──► OpenClaw (网关 + 大脑)
              │
              ├── 轻量任务 → 直接执行 (内置工具)
              │
              └── 重型任务 → 委派 Hermes (容器)
                    ├── 终端 / SSH / Docker backend
                    ├── 浏览器自动化 (Playwright)
                    ├── 代码执行 (PTC)
                    ├── 子任务并行 (delegate)
                    ├── 技能系统
                    └── MCP 服务调用
```

---

## 2. 架构设计

### 2.1 通信架构

v1.1 支持两种通信方式：**stdio** 和 **TCP 常驻进程**（推荐）。

#### 方式 A：stdio (docker exec)

```
┌──────────────────────┐          ┌──────────────────────┐
│      OpenClaw        │          │      Hermes          │
│      (Gateway)       │          │      (Container)     │
│                      │          │                      │
│  ┌────────────────┐  │  stdio   │  ┌────────────────┐  │
│  │  Hermes Plugin │◄─┼─ pipe ──┼─►│  ACP Adapter   │  │
│  │  (docker exec) │  │          │  │  (hermes acp)  │  │
│  └────────────────┘  │          │  └────────────────┘  │
└──────────────────────┘          └──────────────────────┘
```

- 每次任务 spawn 一个 `docker exec hermes-agent hermes acp` 进程
- 通过 stdin/stdout 管道通信
- 简单直接，但每次有 ~2-3s 进程创建开销

#### 方式 B：TCP 常驻进程（推荐）

```
┌──────────────────────┐          ┌──────────────────────┐
│      OpenClaw        │   TCP    │      Hermes          │
│      (Gateway)       │  :3100   │      (Container)     │
│                      │          │                      │
│  ┌────────────────┐  │  NDJSON  │  ┌────────────────┐  │
│  │  Hermes Plugin │◄─┼─JSON-RPC┼─►│  ACP TCP Bridge │  │
│  │  (TCP client)  │  │          │  │  → ACP Adapter  │  │
│  └────────────────┘  │          │  └────────────────┘  │
└──────────────────────┘          └──────────────────────┘
```

- 容器内运行 `acp-tcp-server.py` 常驻进程，监听 TCP 3100 端口
- OpenClaw 插件通过 TCP 连接发送 JSON-RPC 消息
- **帧格式**: NDJSON（每行一个 JSON 对象 + `\n`）
- 每个 TCP 连接创建独立的 `HermesACPAgent` 实例，天然支持并发

**两种方式对比：**

| 对比项 | stdio (docker exec) | TCP (常驻进程) |
|--------|---------------------|---------------|
| 启动延迟 | 每次 ~2-3s (进程创建) | 首次连接后 ~0ms |
| 并发支持 | 单会话 | 多 TCP 连接 → 多会话 |
| 连接管理 | 进程生命周期绑定 | 独立 TCP 连接 |
| 复杂度 | 简单 | 稍复杂 (需 bridge) |
| 健康检查 | 需 exec | TCP connect 即可 |
| 帧格式 | NDJSON | NDJSON（完全相同） |

**通信协议**: Agent Client Protocol (ACP) — Hermes 已内置 ACP adapter (`hermes-acp`)。两种方式使用完全相同的 ACP JSON-RPC 协议和 NDJSON 帧格式。

### 2.2 部署架构

```
┌──────────────────────────────────────────────────────────┐
│                        宿主机                             │
│  ┌────────────────────────────────────────────────────┐  │
│  │                  Docker Engine                     │  │
│  │                                                    │  │
│  │  ┌────────────────────┐                            │  │
│  │  │  OpenClaw Container│  127.0.0.1:13789           │  │
│  │  │  [Hermes Plugin] ◄─┼── TCP :3100 ─────────┐    │  │
│  │  └────────────────────┘                       │    │  │
│  │                                               │    │  │
│  │  ┌────────────────────┐                       │    │  │
│  │  │  Hermes Container  │◄──────────────────────┘    │  │
│  │  │  ACP TCP :3100     │                            │  │
│  │  │  (常驻进程)         │                            │  │
│  │  └────────────────────┘                            │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐      │
│  │   ufw    │  │Tailscale │  │  SSH Tunnel       │      │
│  └──────────┘  └──────────┘  └───────────────────┘      │
└──────────────────────────────────────────────────────────┘
```

### 2.3 ACP TCP Bridge 实现细节

```
acp-tcp-server.py 启动流程:
  ├── 加载 Hermes 环境 (.env, config)
  ├── asyncio.start_server(host=0.0.0.0, port=3100)
  └── 每个 TCP 连接:
      ├── 创建 HermesACPAgent 实例
      ├── 创建 AgentSideConnection(writer, reader)
      ├── conn.listen() — 阻塞式收发循环
      └── 连接关闭时自动清理
```

**关键文件：**

| 文件 | 功能 |
|------|------|
| `scripts/acp-tcp-server.py` | TCP → ACP bridge 服务 |
| `scripts/entrypoint-acp.sh` | 容器入口 (初始化 + 启动 bridge) |
| `docker-compose.acp.yml` | ACP TCP 模式的 compose 配置 |

---

## 3. 三维传递协议

插件的核心设计：每次任务委派时，沿三个正交维度控制 **"传什么"**、**"给什么权限"**、**"回写什么"**。

### 3.1 维度一：传递层级 (Context Level)

控制 Hermes 对用户/项目"知道多少"。

| Level | 名称 | 传递内容 | Token 开销 |
|-------|------|---------|-----------|
| **L0** | Stateless | 指令 + 模型配置 | < 200 |
| **L1** | Tools | + 工具配置 + 命令白名单 + 浏览器配置 | < 500 |
| **L2** | Context | + 自适应记忆 + 身份(SOUL/USER) + AGENTS.md | 500 - 4K |
| **L3** | Full Sync | + 技能文件清单 + MCP 定义 + cron 定义 | 2K - 8K |

> **L2 自适应策略**：总记忆 < 2K tokens 时全量传递；> 2K tokens 时由 OpenClaw 先做 LLM 摘要，只传与当前任务相关的部分。

### 3.2 维度二：凭据范围 (Credential Scope)

控制 Hermes "能访问什么服务"。凭据通过环境变量注入容器，不写入磁盘。

| Scope | 名称 | 传递内容 |
|-------|------|---------|
| **C0** | None | 不传任何凭据 |
| **C1** | Specified | 只传指定凭据 (如 HASS_TOKEN, GITHUB_TOKEN) |
| **C2** | All | 传所有通道凭据 — 仅用户明确授权时使用 |

### 3.3 维度三：回写策略 (Writeback)

控制 Hermes 执行完后"什么写回 OpenClaw"。

| Write | 名称 | 回写内容 |
|-------|------|---------|
| **W0** | None | 不回写 (纯查询) |
| **W1** | Result | 只回写执行结果文本 |
| **W2** | Memory | 回写结果 + 更新 OpenClaw 记忆 |
| **W3** | Full | 回写技能 / cron 定义 / 配置变更 |

### 3.4 三元组表示法

```
hermes_dispatch(
    task      = "帮我在 GitHub 上 fork 这个仓库",
    context   = L1,
    credential= C1(["GITHUB_TOKEN"]),
    writeback = W1
)
```

---

## 4. 场景验证矩阵 (50 场景)

### 4.1 日常对话 & 信息查询

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 1 | 查天气 | L0/C0/W0 | 纯指令 |
| 2 | 翻译文本 | L0/C0/W0 | 纯指令 |
| 3 | 总结 URL 文章 | L1/C0/W1 | web_extract |
| 4 | 搜索对比信息 | L1/C0/W1 | web_search |
| 5 | 分析截图 | L1/C0/W1 | vision |
| 6 | 用"我的语气"写邮件 | L2/C0/W1 | 需身份摘要 |
| 7 | 回忆上周讨论 | L2/C0/W0 | 需记忆 |
| 8 | 查之前记住的 Key | L2/C0/W0 | 需记忆 |

### 4.2 代码 & 开发

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 9 | 格式化 JSON | L0/C0/W0 | 纯指令 |
| 10 | 项目内搜索 | L1/C0/W1 | terminal/file |
| 11 | 跑单元测试 | L1/C0/W1 | terminal |
| 12 | Review PR | L2/C0/W1 | 需项目背景 |
| 13 | 加健康检查端点 | L2/C0/W2 | 需记忆+回写 |
| 14 | 框架迁移 | L2/C0/W2 | 需记忆+回写 |
| 15 | 创建部署 skill | L3/C1/W3 | 需全部+回写技能 |
| 16 | 并行加 Dockerfile | L1/C0/W1 | 并行子任务 |

### 4.3 系统运维

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 17 | 检查磁盘空间 | L1/C0/W1 | terminal |
| 18 | 看 nginx 日志 | L1/C0/W1 | terminal |
| 19 | 更新 Docker 镜像 | L2/C0/W2 | 需知道服务器 |
| 20 | 配置 Tailscale | L2/C0/W2 | 需记忆 |
| 21 | 设置备份 cron | L2/C1/W2 | 需记忆+cron |
| 22 | 一键部署生产 | L3/C1/W3 | 全部 |

### 4.4 文件 & 数据处理

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 23 | PDF 转 markdown | L0/C0/W1 | 纯指令 |
| 24 | 批量重命名文件 | L0/C0/W1 | 纯指令 |
| 25 | 分析 CSV 画图 | L1/C0/W1 | code_execution |
| 26 | 整理下载文件夹 | L1/C0/W1 | file_tools |
| 27 | 录音转文字 | L1/C0/W1 | transcription |

### 4.5 浏览器 & 网页自动化

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 28 | 截图网页 | L1/C0/W1 | browser |
| 29 | GitHub fork 仓库 | L1/C1/W1 | browser+token |
| 30 | 监控商品降价 | L2/C1/W2 | 需通知偏好 |
| 31 | 自动填表单 | L1/C0/W1 | browser |
| 32 | 登录爬数据 | L1/C1/W1 | browser+凭据 |

### 4.6 定时任务 & 自动化

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 33 | 每天发天气预报 | L2/C1/W2 | cron+通道 |
| 34 | 每周生成周报 | L2/C1/W2 | cron+技能 |
| 35 | 监控 GitHub issue | L2/C1/W2 | MCP |
| 36 | 定时清理 /tmp | L1/C0/W1 | terminal+cron |
| 37 | 检查 SSL 证书 | L2/C0/W2 | 需域名列表 |

### 4.7 智能家居

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 38 | 关灯 | L1/C1/W0 | HA |
| 39 | 执行晚安场景 | L2/C1/W0 | HA+习惯 |
| 40 | 创建回家自动化 | L2/C1/W3 | HA+记忆+回写 |

### 4.8 多媒体 & 创作

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 41 | 生成头像 | L1/C1/W1 | image_gen |
| 42 | 文字转语音 | L1/C1/W1 | TTS |
| 43 | 个性化睡前故事 | L2/C1/W1 | TTS+记忆 |
| 44 | 技术博客配图 | L2/C0/W1 | 写作风格 |

### 4.9 跨平台消息

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 45 | Telegram 发通知 | L1/C1/W1 | send_message |
| 46 | Discord 发文件 | L1/C1/W1 | send_message |
| 47 | 统一回复所有消息 | L2/C2/W2 | 全通道 |
| 48 | 双平台发公告 | L2/C2/W1 | 多通道 |

### 4.10 复合场景

| # | 场景 | 策略 | 说明 |
|---|------|------|------|
| 49 | 竞品分析项目 | L3/C1/W2 | 全能力 |
| 50 | 从零建 SaaS | L3/C2/W3 | 全部全开 |

### 4.11 策略分布统计

- **L1+L2** 覆盖 80% 场景
- **C0+C1** 覆盖 94% 场景
- **W1+W2** 覆盖 80% 场景
- **50/50** 全部匹配

---

## 5. 插件 API 设计

### 5.1 核心接口

```typescript
interface DispatchRequest {
  task: string;                              // 任务描述
  contextLevel: "L0" | "L1" | "L2" | "L3";  // 传递层级
  credentialScope: {
    mode: "none" | "specified" | "all";
    keys?: string[];                         // mode=specified 时
  };
  writeback: "W0" | "W1" | "W2" | "W3";     // 回写策略
  model?: string;                            // 覆盖默认模型
  tools?: string[];                          // 限制可用工具
  timeout?: number;                          // 超时(秒)
  files?: FileAttachment[];                  // 附带文件
}

interface DispatchResult {
  status: "success" | "error" | "timeout";
  result: string;                            // 执行结果文本
  artifacts?: Artifact[];                    // 生成的文件
  memoryUpdates?: MemoryUpdate[];            // W2/W3 记忆更新
  skillsCreated?: string[];                  // W3 创建的技能
  tokensUsed: number;
  duration: number;
}
```

### 5.2 上下文组装流程

```
OpenClaw 收到任务
    │
    ▼
策略推断引擎 → 确定 L/C/W 三元组
    │
    ▼
上下文组装器 (Context Assembler)
    ├── L0: { task, model_config }
    ├── L1: + { tool_config, command_allowlist, browser_config }
    ├── L2: + { memory: auto_summarize(), identity, workspace }
    └── L3: + { skills, mcp_servers, cron_definitions }
    │
    ▼
凭据注入器 → C0/C1/C2 注入环境变量
    │
    ▼
ACP 调用 → Hermes Container (TCP :3100 或 stdio)
    │
    ▼
结果处理器 → W0/W1/W2/W3 选择性回写
```

### 5.3 自动策略推断

```python
def infer_strategy(task, tools) -> (L, C, W):

    # L 推断
    if mentions("上次","之前","记得","习惯"):  L = L2
    elif needs(skill_manage, mcp):            L = L3
    elif needs(terminal, browser, ...):       L = L1
    else:                                     L = L0

    # C 推断
    if needs(send_message, ha_*):             C = C1(auto_detect_keys)
    else:                                     C = C0

    # W 推断
    if creates(skill, cron, config):          W = W3
    elif modifies("记住","更新","部署"):       W = W2
    elif query_only("查","看","搜"):           W = W0
    else:                                     W = W1
```

### 5.4 ACP 会话管理

| 模式 | 适用场景 | 生命周期 |
|------|---------|---------|
| **一次性 (run)** | 短任务 < 5 min | 执行完自动销毁 |
| **会话 (session)** | 长任务 5-60 min | 保持会话，支持中间查询 |
| **常驻 (persistent)** | 持续服务 | 常驻后台，接受多次任务 |

### 5.5 ACP 通信层实现（v1.1 新增）

插件 `acp-client.ts` 支持两种 transport：

```typescript
// TCP transport（推荐）
const socket = net.createConnection({ host: "127.0.0.1", port: 3100 });
socket.write(JSON.stringify(jsonrpcMsg) + "\n");  // NDJSON 帧格式

// stdio transport（备选）
const proc = child_process.spawn("docker", ["exec", "-i", "hermes-agent",
  "bash", "-c", "source /opt/hermes/.venv/bin/activate && hermes acp"]);
proc.stdin.write(JSON.stringify(jsonrpcMsg) + "\n");
```

两种 transport 使用完全相同的 JSON-RPC 协议和 NDJSON 帧格式。

---

## 6. 数据映射表

基于 Hermes 迁移脚本 `openclaw_to_hermes.py` 的完整字段映射。

### 6.1 OpenClaw → Hermes 映射

| OpenClaw 数据 | Hermes 目标 | 层级 |
|--------------|------------|------|
| SOUL.md | SOUL.md (rebrand) | L2 |
| USER.md | memories/USER.md | L2 |
| MEMORY.md | memories/MEMORY.md | L2 |
| memory/*.md (daily) | memories/MEMORY.md (merged) | L2 |
| AGENTS.md | workspace instructions | L2 |
| workspace/skills/ | skills/openclaw-imports/ | L3 |
| exec-approvals.json | config.yaml command_allowlist | L1 |
| agents.defaults.model | config.yaml model.default | L0 |
| agents.defaults.sandbox | config.yaml terminal.backend | L1 |
| tools.exec.timeoutSec | config.yaml terminal.timeout | L1 |
| browser.cdpUrl | config.yaml browser.cdp_url | L1 |
| mcp.servers.* | config.yaml mcp_servers | L3 |
| messages.tts.provider | config.yaml tts.provider | L1 |
| channels.telegram.botToken | .env TELEGRAM_BOT_TOKEN | C1/C2 |
| channels.discord.token | .env DISCORD_BOT_TOKEN | C1/C2 |
| models.providers.*.apiKey | .env *_API_KEY | C1 |

### 6.2 Hermes → OpenClaw 回写映射

| Hermes 产出 | OpenClaw 目标 | 回写级别 |
|------------|--------------|---------|
| 执行结果文本 | 对话上下文 | W1 |
| 生成的文件 | workspace/ | W1 |
| 新记忆条目 | MEMORY.md append | W2 |
| 任务学习总结 | memory/YYYY-MM-DD.md | W2 |
| 新创建的技能 | workspace/skills/ | W3 |
| 新 cron 任务 | cron 系统 | W3 |
| 配置变更建议 | 人工审核后应用 | W3 |

---

## 7. 安全设计

### 7.1 凭据隔离

- 所有凭据集中管理在 OpenClaw 侧
- Hermes 容器内**不持久化**任何凭据
- 传递方式：环境变量注入 (`docker run -e`)，单次有效
- C2 使用需要用户确认
- 每次凭据传递记录审计日志

### 7.2 执行沙箱

```
Hermes 容器安全约束:
├── read_only filesystem (tmpfs for /tmp)
├── no-new-privileges
├── 非 root 运行 (uid 1000)
├── 无 docker.sock 挂载
├── 资源限制 (CPU/MEM)
├── 网络隔离 (internal network)
└── 命令白名单 (command_allowlist)
```

### 7.3 回写安全

| 回写级别 | 安全约束 |
|---------|---------|
| W1 Result | 无限制，直接返回 |
| W2 Memory | 自动追加，不覆盖已有记忆 |
| W3 Full | 技能/cron/配置变更 — **需要用户确认** |

### 7.4 TCP 端口安全（v1.1 新增）

- ACP TCP 端口 (3100) 仅绑定 Docker internal network，不对外暴露
- 生产环境建议 `ports: "127.0.0.1:3100:3100"` 限制本地访问
- 无认证机制（依赖网络隔离），如需公网暴露应加 mTLS 或 SSH tunnel

---

## 8. 实现路线图

| 阶段 | 内容 | 周期 |
|------|------|------|
| **Phase 1** 基础通信 | 插件骨架 · ACP 启动/停止 · L0/L1 委派 · W1 回传 · 健康检查 | 1-2 周 |
| **Phase 2** 上下文传递 | L2 记忆/身份摘要 · 自适应截取 · 策略推断 · C1 凭据注入 | 1-2 周 |
| **Phase 3** 完整集成 | L3 技能/MCP 同步 · W2 记忆回写 · W3 技能/cron 回写 · C2 全凭据 | 1-2 周 |
| **Phase 4** 优化打磨 | 长任务进度 · 错误恢复 · 连接池/会话复用 · 文档测试 | 1 周 |

---

## 9. 项目文件结构

```
openclaw-plugin-hermes/
├── package.json
├── tsconfig.json
├── openclaw.plugin.json          # 插件声明
├── src/
│   ├── index.ts                  # 插件入口
│   ├── dispatcher.ts             # 任务分发器
│   ├── context-assembler.ts      # 上下文组装
│   ├── credential-injector.ts    # 凭据注入
│   ├── result-processor.ts       # 结果处理
│   ├── strategy-engine.ts        # 策略推断
│   ├── acp-client.ts             # ACP 通信 (TCP + stdio)
│   ├── health.ts                 # 健康检查
│   └── types.ts                  # 类型定义
├── hermes/
│   ├── Dockerfile                # Hermes 容器
│   ├── docker-compose.yml        # 编排 (gateway 模式)
│   ├── docker-compose.acp.yml    # 编排 (ACP TCP 模式)
│   └── config/                   # 默认配置模板
└── tests/
    ├── dispatch.test.ts
    ├── context.test.ts
    └── strategy.test.ts

hermes-containerized/
├── Dockerfile
├── docker-compose.yml            # gateway 模式
├── docker-compose.acp.yml        # ACP TCP 模式 (推荐)
├── scripts/
│   ├── entrypoint-fix.sh         # gateway 入口│   ├── entrypoint-acp.sh        # ACP TCP 入口
│   ├── acp-tcp-server.py        # TCP → ACP bridge
│   └── test-acp-tcp.py          # TCP 测试客户端
├── data/                         # 持久化数据卷
├── docs/
│   ├── plugin-design.md          # 本文档
│   ├── plugin-design.html        # HTML 版本
│   ├── plugin-design-v1.1.pdf    # PDF 版本
│   ├── plugin-verification.md    # 验证报告
│   └── plugin-verification-v1.1.pdf
└── src/                          # Hermes 源码 (只读挂载)
```

---

## 10. 风险与决策记录

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| ACP 协议版本不兼容 | 通信失败 | 固定 ACP SDK 版本 + 集成测试 |
| Hermes 容器启动慢 (~10s) | 首次延迟高 | 常驻模式 + 预热 |
| 记忆摘要质量差 | 上下文丢失 | 双路验证：摘要 + 关键词提取 |
| 凭据泄漏 | 安全事故 | 环境变量注入 + 不持久化 + 审计 |
| 回写冲突 (并发) | 数据损坏 | 追加写入 + 乐观锁 |
| Hermes 更新破坏兼容性 | 插件失效 | 固定镜像版本 + 集成测试 |
| TCP 端口暴露 (v1.1) | 未授权访问 | 绑定 127.0.0.1 + 网络隔离 |

---

## 11. 验证结果

### 11.1 ACP 协议修正 (v1.0, 2026-04-14)

实际验证发现以下协议差异，已在插件代码中修正：

| 原设计 | 实际 | 说明 |
|--------|------|------|
| `new_session` | `session/new` | ACP 使用命名空间方法名 |
| `prompt` | `session/prompt` | 同上 |
| `cancel` | `session/cancel` | 同上 |
| `session_id` 参数 | `sessionId` | camelCase |
| `{cwd}` | `{cwd, mcpServers: []}` | mcpServers 必填 |
| `data.text` | `data.content.text` | 文本包裹在 content 对象中 |
| `agent_message_text` | `agent_message_chunk` | 事件类型用 chunk 后缀 |

### 11.2 stdio 端到端验证 (v1.0, 2026-04-14)

```
✅ initialize → hermes-agent v0.8.0 (ACP protocol v1)
✅ session/new → sessionId 创建成功
✅ session/prompt → 流式事件接收正常
✅ agent_thought_chunk → 思考过程正确传递
✅ agent_message_chunk → 文本回复正确接收 ("收到")
✅ PromptResponse → stop_reason=end_turn, usage=14903 tokens
✅ TypeScript 编译 → 9 个模块 2355 行，零错误
```

### 11.3 TCP 常驻进程端到端验证 (v1.1, 2026-04-15)

```
✅ TCP connect 127.0.0.1:3100 → 连接成功
✅ initialize → hermes-agent v0.8.0, Protocol v1
✅ session/new → sessionId: 2e8f569e-... 创建成功
✅ session/prompt("回复两个字") → 流式事件接收正常
✅ available_commands_update → 斜杠命令列表
✅ agent_thought_chunk → 思考过程
✅ agent_message_chunk → "好的"
✅ PromptResponse → stop_reason=end_turn, usage=14834/23/14857
```

**关键发现 (v1.1):**

- ACP SDK 使用 **NDJSON 帧格式** (每行一个 JSON + `\n`)，不是 Content-Length
- `AgentSideConnection` 构造后需调用 `conn.listen()` 运行收发循环
- 每个 TCP 连接创建独立 Agent 实例，天然支持并发

### 11.4 插件实现产出

已实现完整插件项目 `openclaw-plugin-hermes/`：

| 模块 | 文件 | 功能 |
|------|------|------|
| 入口 | `src/index.ts` | 注册 3 个工具 |
| 类型 | `src/types.ts` | 三维协议类型定义 |
| ACP | `src/acp-client.ts` | JSON-RPC 客户端 (TCP + stdio) |
| 调度 | `src/dispatcher.ts` | 核心编排流水线 |
| 策略 | `src/strategy-engine.ts` | L/C/W 自动推断 |
| 上下文 | `src/context-assembler.ts` | L0-L3 上下文组装 |
| 凭据 | `src/credential-injector.ts` | C0-C2 凭据注入 |
| 结果 | `src/result-processor.ts` | W0-W3 回写处理 |
| 健康 | `src/health.ts` | 容器健康检查 |

---

*OpenClaw × Hermes 插件集成方案 v1.1 | 2026-04-15 | 作者: Sol (索尔)*
