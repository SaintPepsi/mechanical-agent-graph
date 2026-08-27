#!/bin/sh
# Reaches init, starts generating, then goes silent forever: the idle bound's case.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-stall"}'
printf '%s\n' '{"type":"stream_event","session_id":"sess-stall","event":{"type":"message_start"}}'
while true; do sleep 30; done
