#!/bin/sh
# Unparseable on the first call, clean JSON once resumed: the schemaless nudge path.
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then RESUMED=1; fi
done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-nudge"}'
if [ -n "$RESUMED" ]; then
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-nudge","total_cost_usd":0.25,"result":"{\"status\":\"pass\"}"}'
else
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-nudge","total_cost_usd":1,"result":"{status: pass, no quotes anywhere}"}'
fi
