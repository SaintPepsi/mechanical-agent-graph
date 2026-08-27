#!/bin/sh
# The CLI's own structured-output retries ran out.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-retries"}'
printf '%s\n' '{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"session_id":"sess-retries","total_cost_usd":0.1,"result":"could not satisfy the schema"}'
