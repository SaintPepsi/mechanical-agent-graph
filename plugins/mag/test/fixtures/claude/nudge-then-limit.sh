#!/bin/sh
# First call answers with prose, so the transport nudges. The nudge resume then hits a usage limit
# and exits 0 with a failed result message carrying api_error_status 429 — the same shape
# limit-in-result.sh uses on the first spawn. A limit is a limit whichever spawn meets it.
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then RESUMED=1; fi
done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-nudge-limit"}'
if [ -n "$RESUMED" ]; then
  printf '%s\n' '{"type":"system","subtype":"api_retry","session_id":"sess-nudge-limit","error":"rate_limit","error_status":429,"retry_delay_ms":60000}'
  printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sess-nudge-limit","api_error_status":429,"total_cost_usd":0.1,"result":null}'
else
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-nudge-limit","total_cost_usd":0.5,"result":"I think it passes, honestly."}'
fi
