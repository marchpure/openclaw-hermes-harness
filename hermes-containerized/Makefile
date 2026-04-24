# ============================================================
# Hermes Agent 容器化 — Makefile
# ============================================================

.PHONY: help clone build up up-acp down down-acp logs logs-acp shell shell-acp test clean

help: ## 显示帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

clone: ## 克隆 Hermes Agent 源码
	@if [ ! -d src ]; then \
		git clone --depth 1 https://github.com/NousResearch/hermes-agent.git src; \
	else \
		echo "src/ already exists, skipping clone"; \
	fi

setup: clone ## 初始化项目 (克隆 + 准备 data 目录 + .env)
	@mkdir -p data
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from template — please edit it with your API keys"; \
	fi
	@echo "Setup complete. Run 'make build' next."

build: ## 构建 Docker 镜像
	docker compose build

up: ## 启动 Hermes (gateway 常驻模式, 后台)
	docker compose up -d

up-acp: ## 启动 Hermes (gateway + ACP TCP 双进程模式, 后台)
	docker compose -f docker-compose.acp.yml up -d

down: ## 停止 Hermes (gateway 模式)
	docker compose down

down-acp: ## 停止 Hermes (ACP 模式)
	docker compose -f docker-compose.acp.yml down

logs: ## 查看日志 (gateway 模式)
	docker compose logs -f hermes

logs-acp: ## 查看日志 (ACP 模式)
	docker compose -f docker-compose.acp.yml logs -f hermes-acp

shell: ## 进入容器 shell (gateway 模式)
	docker compose exec hermes bash

shell-acp: ## 进入容器 shell (ACP 模式)
	docker compose -f docker-compose.acp.yml exec hermes-acp bash

test: ## 运行基本健康检查
	@echo "=== Hermes Agent 健康检查 ==="
	@echo ""
	@echo "1. 检查容器状态..."
	@docker compose ps 2>/dev/null || docker compose -f docker-compose.acp.yml ps 2>/dev/null
	@echo ""
	@echo "2. 检查 hermes 版本..."
	@docker compose run --rm hermes version 2>/dev/null || echo "  (容器未构建或未运行)"
	@echo ""
	@echo "3. 检查 Python 环境..."
	@docker compose run --rm --entrypoint="" hermes bash -c "source /opt/hermes/.venv/bin/activate && python3 -c 'import hermes; print(f\"hermes module OK\")'" 2>/dev/null || echo "  (检查失败)"
	@echo ""
	@echo "=== 检查完成 ==="

clean: ## 清理所有 (镜像 + 数据)
	docker compose down -v --rmi local 2>/dev/null || true
	docker compose -f docker-compose.acp.yml down -v --rmi local 2>/dev/null || true
	@echo "Cleaned. Data in ./data/ preserved (delete manually if needed)."
