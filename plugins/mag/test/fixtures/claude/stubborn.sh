#!/bin/sh
# Unparseable on the first call and still unparseable after the nudge.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-stubborn"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-stubborn","total_cost_usd":0.25,"result":"no json here at all"}'
