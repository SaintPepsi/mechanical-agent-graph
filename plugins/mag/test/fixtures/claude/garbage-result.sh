#!/bin/sh
# A result line whose own shape is wrong: is_error is a string, not a boolean.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-garbage"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":"nope","session_id":"sess-garbage"}'
