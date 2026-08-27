#!/bin/sh
# Fails as CLAUDE_USAGE_LIMIT on every call, and records that it was invoked in its own working
# directory (the manifest names no count-file environment variable). The corrective resume
# must not fire for this tag, so a test counts invocations here and asserts there is one.
echo x >> count.txt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-limit-once"}'
echo 'Claude AI usage limit reached. Resets at 2026-08-17T22:00:00Z' >&2
exit 1
