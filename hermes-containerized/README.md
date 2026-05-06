# Hermes Agent 容器化部署

将 [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) 容器化部署，集成火山方舟 MiniMax-M2.5 模型。

## 项目结构

```
hermes-containerized/
├── Dockerfile              # 容器构建 (国内源优化)
├── docker-compose.yml      # 编排配置
├── Makefile                # 快捷命令
├── .env.example            # 环境变量模板
├── .env                    # 实际环境变量 (git ignored)
├── .gitignore
├── README.md
├── src/                    # Hermes Agent 源码 (git clone)
├── data/                   # 持久化数据 (运行时生成)
│   ├── config.yaml         # Hermes 配置
│   ├── .env                # Hermes 内部环境变量
│   ├── memories/           # 记忆
│   ├── skills/             # 技能
│   ├── sessions/           # 会话
│   ├── workspace/          # 工作区
│   └── ...
└── scripts/                # 辅助脚本
    └── test-model.sh       # 模型连通性测试
```

## 快速开始

```bash
# 1. 初始化项目
make setup

# 2. 编辑 .env，填入 API Key 和 Base URL
vim .env

# 3. 构建镜像
make build

# 4. 启动 (gateway 模式)
make up

# 5. 交互对话
make chat

# 6. 查看日志
make logs
```

## 模型配置

支持国内与海外火山方舟 ARK / BytePlus 端点：

- **国内 ARK**: `https://ark.cn-beijing.volces.com/api/coding/v3`
- **海外 ARK**: `https://ark.ap-southeast.bytepluses.com/api/coding/v3`
- **Model ID**: `minimax-m2.5`
- **协议**: OpenAI-compatible

如果你是通过仓库根目录的 `scripts/hermes-install.sh` 安装，并且 OpenClaw 已经配置好 provider、model、apiKey 和 baseUrl，安装脚本会直接复用 OpenClaw 中的配置。

首次启动后，编辑 `data/config.yaml` 修改模型配置：

```yaml
model:
  default: minimax-m2.5
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `make build` | 构建镜像 |
| `make up` | 启动 (后台) |
| `make down` | 停止 |
| `make chat` | 交互对话 |
| `make logs` | 查看日志 |
| `make shell` | 进入容器 |
| `make test` | 健康检查 |
| `make clean` | 清理 |
