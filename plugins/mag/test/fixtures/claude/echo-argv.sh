#!/bin/sh
# Writes its own argv, one entry per line, into argv.txt in its own working directory, then answers
# normally. The manifest names no argv-file environment variable, so the test hands this fixture a
# scratch directory as its cwd instead of a path through the environment.
: > argv.txt
for arg in "$@"; do printf '%s\n' "$arg" >> argv.txt; done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-argv"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-argv","total_cost_usd":0.01,"result":"{}","structured_output":{}}'
