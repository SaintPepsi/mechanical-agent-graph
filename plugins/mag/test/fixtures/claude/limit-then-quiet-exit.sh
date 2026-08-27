#!/bin/sh
# Announces a rate-limit retry, then exits 0 saying nothing. Neither the non-zero-exit path nor the
# result-message path sees this, so the reset time has to survive the no-result-message branch.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-quiet"}'
printf '%s\n' '{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429,"retry_delay_ms":60000,"session_id":"sess-quiet"}'
exit 0
