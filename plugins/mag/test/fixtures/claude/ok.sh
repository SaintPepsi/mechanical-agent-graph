#!/bin/sh
# A well-behaved schema'd run: the documented init line, then a success result carrying
# structured_output. Ignores every flag but --resume.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-ok"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-ok","total_cost_usd":0.25,"result":"{\"status\":\"pass\"}","structured_output":{"status":"pass"}}'
