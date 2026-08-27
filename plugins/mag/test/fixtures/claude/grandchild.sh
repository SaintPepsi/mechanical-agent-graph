#!/bin/sh
# Starts a background grandchild, records its pid in grandchild.pid in its own working directory
# (the manifest names no pid-file environment variable), then stalls.
# Proves the negative-pid kill reaches the whole process group, not just the direct child.
sleep 300 &
echo "$!" > grandchild.pid
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-group"}'
printf '%s\n' '{"type":"stream_event","session_id":"sess-group","event":{"type":"message_start"}}'
wait
