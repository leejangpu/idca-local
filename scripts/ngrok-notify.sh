#!/bin/bash
# ngrok SSH 터널 주소 감시 + 텔레그램 전송 스크립트

ENV_FILE="/Users/jangpu/Documents/workspace/idca-local/.env"

TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r')
ADMIN_TELEGRAM_CHAT_ID=$(grep '^ADMIN_TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r')

NGROK_API="http://127.0.0.1:4040/api/tunnels"
LAST_ADDR=""
CHECK_INTERVAL=3600

send_telegram() {
  local addr="$1"
  local host port timestamp msg

  host=$(echo "$addr" | sed 's|tcp://||' | cut -d':' -f1)
  port=$(echo "$addr" | sed 's|tcp://||' | cut -d':' -f2)
  timestamp=$(TZ='Asia/Seoul' date '+%Y-%m-%d %H:%M:%S')

  msg="🔗 SSH 터널 활성화
ssh jangpu@${host} -p ${port}
갱신시각: ${timestamp} KST"

  # 메시지 전송 후 pin
  local result
  result=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${ADMIN_TELEGRAM_CHAT_ID}" \
    -d text="${msg}")

  local message_id
  message_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['message_id'])" 2>/dev/null)

  if [ -n "$message_id" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/pinChatMessage" \
      -d chat_id="${ADMIN_TELEGRAM_CHAT_ID}" \
      -d message_id="${message_id}" \
      > /dev/null 2>&1
  fi

  echo "[$(date)] 텔레그램 전송+고정 완료: ${addr}"
}

get_tunnel_addr() {
  curl -s "$NGROK_API" 2>/dev/null | \
    python3 -c "import sys,json; tunnels=json.load(sys.stdin).get('tunnels',[]); print(tunnels[0]['public_url'] if tunnels else '')" 2>/dev/null || echo ""
}

echo "[$(date)] ngrok 주소 감시 시작..."

while true; do
  ADDR=$(get_tunnel_addr)

  if [ -n "$ADDR" ] && [ "$ADDR" != "$LAST_ADDR" ]; then
    echo "[$(date)] 새 주소 감지: ${ADDR}"
    send_telegram "$ADDR"
    LAST_ADDR="$ADDR"
  elif [ -z "$ADDR" ] && [ -n "$LAST_ADDR" ]; then
    echo "[$(date)] 터널 연결 끊김, 재연결 대기..."
    LAST_ADDR=""
  fi

  sleep "$CHECK_INTERVAL"
done
