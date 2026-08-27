#!/bin/sh
# Dies against a usage limit, saying so on stderr only — the real shape a usage-limit failure takes.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-limit"}'
echo 'Claude AI usage limit reached. Resets at 2026-08-17T22:00:00Z' >&2
exit 1
