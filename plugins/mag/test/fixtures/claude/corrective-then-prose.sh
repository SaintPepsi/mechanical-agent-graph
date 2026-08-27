#!/bin/sh
# Exits 1 on the first call; the corrective resume answers, but with nothing parseable in it.
# The schemaless nudge must not then fire: the one resume this call is allowed is already spent.
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then RESUMED=1; fi
done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-corrective-prose"}'
if [ -n "$RESUMED" ]; then
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-corrective-prose","total_cost_usd":0.25,"result":"I could not produce a verdict for that."}'
else
  echo 'schema validation failed' >&2
  exit 1
fi
