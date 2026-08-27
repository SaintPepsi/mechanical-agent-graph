#!/bin/sh
# Writes its stream in fragments that have no relationship to line boundaries, splits a multi-byte
# character across two writes, and closes on a line that never gets its newline.
printf '%s' '{"type":"system","subtype":"init","ses'
printf '%s' 'sion_id":"sess-chunk"}
{"type":"result","subtype":"success","is_error":false,"session_id":"sess-chunk","total_cost_usd":0.25,"result":"{\"status\":\"pass\",\"note\":\"caf'
# The two bytes of "é" (0xC3 0xA9), one per write.
printf '\303'
printf '\251'
printf '%s' '\"}"}'
