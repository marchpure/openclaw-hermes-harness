#!/bin/bash
# ============================================================
# 模型连通性测试 — 验证 MiniMax-M2.5 via ARK API
# ============================================================
set -e

# 从 .env 读取配置
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

API_KEY="${OPENAI_API_KEY:?请在 .env 中设置 OPENAI_API_KEY}"
BASE_URL="${OPENAI_BASE_URL:?请在 .env 中设置 OPENAI_BASE_URL。国内可用 https://ark.cn-beijing.volces.com/api/coding/v3，海外可用 https://ark.ap-southeast.bytepluses.com/api/coding/v3}"
MODEL="${1:-minimax-m2.5}"

echo "=== 模型连通性测试 ==="
echo "  API Base: ${BASE_URL}"
echo "  Model:    ${MODEL}"
echo "  API Key:  ${API_KEY:0:12}..."
echo ""

echo "发送测试请求..."
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"说一个字：好\"}],
    \"max_tokens\": 10
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo ""
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ 连接成功 (HTTP $HTTP_CODE)"
    echo ""
    echo "响应内容:"
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
else
    echo "❌ 连接失败 (HTTP $HTTP_CODE)"
    echo ""
    echo "错误响应:"
    echo "$BODY"
    exit 1
fi
