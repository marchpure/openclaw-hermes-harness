# ============================================================
# Hermes Agent — 容器化构建 (中国大陆优化)
# ============================================================
# 基于官方 Dockerfile 改造，使用国内镜像源加速
# 默认以 gateway 常驻模式运行
# ============================================================

FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie AS uv_source
FROM debian:13.4

# ─── 代理配置 (通过 --build-arg 传入) ────────────────────────
ARG http_proxy=
ARG https_proxy=
ARG no_proxy=
ENV http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    no_proxy=${no_proxy}

# ─── 基础环境变量 ─────────────────────────────────────────
ENV PYTHONUNBUFFERED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright
ENV DEBIAN_FRONTEND=noninteractive

# ─── 替换 APT 为国内源 (清华) ───────────────────────────────
RUN sed -i 's|http://deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# ─── 安装系统依赖 ─────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        nodejs npm \
        python3 python3-dev \
        ripgrep ffmpeg \
        gcc libffi-dev \
        procps curl git \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ─── 配置 npm 国内源 ──────────────────────────────────────
RUN npm config set registry https://registry.npmmirror.com

# ─── 配置 pip 源 (清华主源 + 官方 fallback) ──────────────────
RUN mkdir -p /etc/pip && \
    echo '[global]' > /etc/pip/pip.conf && \
    echo 'index-url = https://pypi.tuna.tsinghua.edu.cn/simple' >> /etc/pip/pip.conf && \
    echo 'extra-index-url = https://pypi.org/simple' >> /etc/pip/pip.conf && \
    echo 'trusted-host = pypi.tuna.tsinghua.edu.cn pypi.org' >> /etc/pip/pip.conf

# ─── 配置 uv 源 (清华主源 + 官方 fallback) ──────────────────
ENV UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_EXTRA_INDEX_URL=https://pypi.org/simple

# ─── 非 root 用户 ─────────────────────────────────────────
RUN useradd -u 10000 -m -d /opt/data hermes

# ─── 复制工具 ──────────────────────────────────────────────
COPY --chmod=0755 --from=uv_source /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

# ─── 复制源码 ──────────────────────────────────────────────
COPY src/ /opt/hermes/

# ─── 复制自定义脚本 ────────────────────────────────────────
COPY scripts/entrypoint-gateway.sh /opt/hermes/docker/entrypoint-gateway.sh
COPY scripts/entrypoint-acp.sh     /opt/hermes/docker/entrypoint-acp.sh
COPY scripts/acp-tcp-server.py     /opt/hermes/acp-tcp-server.py

WORKDIR /opt/hermes

# ─── 安装 Node 依赖 + Playwright ──────────────────────────
RUN npm install --prefer-offline --no-audit && \
    npx playwright install --with-deps chromium --only-shell && \
    cd /opt/hermes/scripts/whatsapp-bridge && \
    npm install --prefer-offline --no-audit && \
    npm cache clean --force

# ─── 安装 Python 依赖 ─────────────────────────────────────
RUN chown -R hermes:hermes /opt/hermes
USER hermes

RUN uv venv && \
    uv pip install --no-cache-dir -e ".[all]"

# ─── 设置入口 ──────────────────────────────────────────────
USER root
RUN chmod +x /opt/hermes/docker/entrypoint-gateway.sh \
             /opt/hermes/docker/entrypoint-acp.sh

# ─── 清除代理 (运行时不需要) ──────────────────────────────
ENV http_proxy= \
    https_proxy= \
    no_proxy=

ENV HERMES_HOME=/opt/data
VOLUME [ "/opt/data" ]
ENTRYPOINT [ "/opt/hermes/docker/entrypoint-gateway.sh" ]
CMD [ "gateway", "run" ]
