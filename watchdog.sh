#!/usr/bin/env bash
# Watchdog del minio-upload-service.
#
# Backstop para CUELGUES: un proceso puede estar vivo (PM2 lo ve "online") pero sin
# responder en el puerto — PM2 no detecta eso por sí solo. Este script pega a /health
# cada minuto (vía cron) y, si no responde 2 veces SEGUIDAS, reinicia el servicio.
# El umbral de 2 evita reiniciar por un blip transitorio de una sola corrida.
set -u

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PM2_HOME="/home/nicolas/.pm2"

URL="http://localhost:3002/health"
STATE="/tmp/upload_watchdog_fails"
LOG="/home/nicolas/files/logs/watchdog.log"
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

if curl -fsS --max-time 8 "$URL" >/dev/null 2>&1; then
  # Sano: si venía de una racha de fallas, lo dejo asentado y reseteo el contador.
  if [ "$(cat "$STATE" 2>/dev/null || echo 0)" != "0" ]; then
    echo "$(ts) OK — /health responde de nuevo" >> "$LOG"
  fi
  echo 0 > "$STATE"
  exit 0
fi

# Falla: incrementar el contador de fallas consecutivas.
fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
echo "$(ts) /health NO responde (fallo consecutivo #$fails)" >> "$LOG"

if [ "$fails" -ge 2 ]; then
  echo "$(ts) >>> reiniciando minio-upload-service via PM2" >> "$LOG"
  pm2 restart minio-upload-service >> "$LOG" 2>&1
  echo 0 > "$STATE"
fi
