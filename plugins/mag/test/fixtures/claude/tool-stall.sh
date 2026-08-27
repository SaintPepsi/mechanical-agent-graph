#!/bin/sh
# Starts, generates, stops generating, then goes quiet while "in a tool".
# The only fixture that reaches WAITING after start, which is the state the 900-second tool bound
# guards in production. Without it, `message_stop` and IdleTimeout{bound:"tool"} are unreachable.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-tool"}'
printf '%s\n' '{"type":"stream_event","session_id":"sess-tool","event":{"type":"message_start"}}'
printf '%s\n' '{"type":"stream_event","session_id":"sess-tool","event":{"type":"message_stop"}}'
sleep 300
