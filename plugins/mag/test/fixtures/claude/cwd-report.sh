#!/bin/sh
# Reports its own working directory, so a test can confirm SpawnRequest.cwd reached Bun.spawn's
# `cwd` option: the build node must run inside the ticket's checkout.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-cwd"}'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-cwd","total_cost_usd":0.01,"result":"{}","structured_output":{"cwd":"%s"}}\n' "$(pwd)"
