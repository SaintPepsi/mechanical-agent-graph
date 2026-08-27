#!/bin/sh
# Reports which named values reached the child, so the composed environment (`composeEnv`/
# `ENV_MANIFEST`) is testable end to end against a real process: an ANTHROPIC_* key
# (the escape hatch's own reach), TARGET_REPO_SECRET standing in for a credential a target repo's
# `.env` put in the parent's environment, and PATH, the floor every spawned process needs.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-env"}'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-env","total_cost_usd":0.01,"result":"{}","structured_output":{"anthropic":"%s","foreign":"%s","hasPath":%s}}\n' \
  "${ANTHROPIC_API_KEY:-absent}" "${TARGET_REPO_SECRET:-absent}" "$([ -n "$PATH" ] && echo true || echo false)"
