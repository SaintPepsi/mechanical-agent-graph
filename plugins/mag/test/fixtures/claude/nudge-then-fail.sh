#!/bin/sh
# Unparseable on the first call, exits 1 on the nudge resume, answers on the corrective resume.
# Drives the full three-spawn chain: first spawn, nudge, corrective.
BRIEF=""
NEXT=""
for arg in "$@"; do
  if [ "$NEXT" = "1" ]; then BRIEF="$arg"; NEXT=""; fi
  if [ "$arg" = "-p" ]; then NEXT=1; fi
done

case "$BRIEF" in
  "Your previous reply was not parseable"*)
    echo 'the nudge itself fell over' >&2
    exit 1
    ;;
  "Your previous structured output failed schema validation"*)
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-chain"}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-chain","total_cost_usd":0.25,"result":"{\"status\":\"pass\"}"}'
    ;;
  *)
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-chain"}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-chain","total_cost_usd":1,"result":"nothing parseable here"}'
    ;;
esac
