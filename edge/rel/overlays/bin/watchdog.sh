#!/bin/sh
# Release wrapper: start the BEAM, then probe /health from OUTSIDE the VM.
#
# Exists because the BEAM can become unresponsive without crashing (see the
# 2026-07-12 wedge post-mortem: SHARED-CPU squeeze + scheduler busy-wait):
# process alive, zero log output, HTTP dead — invisible to anything that only
# watches for exits. On sustained probe failure this dumps OS-level forensics
# to stdout (-> service logs) and kills the VM; the platform's runtime
# supervisor restarts the container when the start command exits, so a wedge
# now self-heals in ~1 minute and leaves evidence behind.
set -u
PORT="${PORT:-4000}"
PROBE_EVERY=15
MAX_FAILS=4

bin/noola_edge start &
BEAM=$!

fails=0
while kill -0 "$BEAM" 2>/dev/null; do
  sleep "$PROBE_EVERY"
  if wget -q -T 5 -O /dev/null "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
    fails=0
  else
    fails=$((fails + 1))
    echo "[watchdog] /health probe failed (${fails}/${MAX_FAILS}) nproc=$(nproc) loadavg=$(cut -d' ' -f1-3 /proc/loadavg)"
    if [ "$fails" -ge "$MAX_FAILS" ]; then
      echo "[watchdog] WEDGE: ${MAX_FAILS} consecutive failures — forensics, then restart"
      echo "[watchdog] beam: $(grep -E 'State|Threads|VmRSS|VmSwap' "/proc/${BEAM}/status" 2>/dev/null | tr '\n\t' '  ')"
      echo "[watchdog] fds: $(ls "/proc/${BEAM}/fd" 2>/dev/null | wc -l)"
      echo "[watchdog] tcp states (hex): $(awk 'NR>1{print $4}' /proc/net/tcp | sort | uniq -c | tr '\n' ' ')"
      echo "[watchdog] cpu since boot: $(head -1 /proc/stat)"
      kill -9 "$BEAM" 2>/dev/null
      wait "$BEAM" 2>/dev/null
      exit 1
    fi
  fi
done

echo "[watchdog] beam exited on its own"
wait "$BEAM" 2>/dev/null
exit 1
