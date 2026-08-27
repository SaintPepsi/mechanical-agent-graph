#!/bin/sh
# Dies by signal rather than by exit code, the shape an OOM kill produces.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-signal"}'
kill -KILL $$
