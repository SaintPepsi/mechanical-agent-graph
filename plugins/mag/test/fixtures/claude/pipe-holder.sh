#!/bin/sh
# Answers correctly and exits 0, leaving a background descendant holding the inherited stdout and
# stderr pipes open — the shape a wedged MCP server or any backgrounded tool leaves behind.
# Waiting for stream EOF rather than the child's own exit hangs here until the tool bound fires.
sleep 300 &
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-holder"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-holder","total_cost_usd":0.25,"result":"{\"status\":\"pass\"}","structured_output":{"status":"pass"}}'
exit 0
