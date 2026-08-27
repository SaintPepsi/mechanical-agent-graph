#!/bin/sh
# Exits 0 and reports the limit on the result message itself, where `api_error_status` lives.
# This is the exit-0 path, which spawn.ts never sees and agent.ts classifies.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-status"}'
printf '%s\n' '{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429,"retry_delay_ms":60000,"session_id":"sess-status"}'
printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sess-status","api_error_status":429,"total_cost_usd":0.02,"result":null}'
