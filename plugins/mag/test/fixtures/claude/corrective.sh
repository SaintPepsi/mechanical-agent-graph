#!/bin/sh
# Exits 1 on the first call and answers on the resume: exercises the corrective-resume path.
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then RESUMED=1; fi
done
if [ -n "$RESUMED" ]; then
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-corrective"}'
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-corrective","total_cost_usd":0.25,"result":"{\"status\":\"pass\"}","structured_output":{"status":"pass"}}'
else
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-corrective"}'
  echo 'schema validation failed' >&2
  exit 1
fi
