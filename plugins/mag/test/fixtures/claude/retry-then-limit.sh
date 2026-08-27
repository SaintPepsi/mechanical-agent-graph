#!/bin/sh
# Announces a rate-limit retry with a delay, then dies: the api_retry path to a reset time.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-retry"}'
printf '%s\n' '{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429,"retry_delay_ms":60000,"session_id":"sess-retry"}'
echo 'giving up' >&2
exit 1
