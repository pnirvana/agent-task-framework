#!/usr/bin/env bash
# Demo app: logs like a small web service until stopped.
echo "$(date +%T) INFO  demo-web starting on :8080"
sleep 2; echo "$(date +%T) INFO  connected to database"
echo "$(date +%T) INFO  started in 2.3s"
i=0
while true; do
  sleep 3; i=$((i+1))
  echo "$(date +%T) INFO  GET /health 200 ($((RANDOM % 20 + 2))ms)"
  [ $((i % 5)) -eq 0 ] && echo "$(date +%T) WARN  slow query: SELECT * FROM orders ($((RANDOM % 900 + 600))ms)"
done
