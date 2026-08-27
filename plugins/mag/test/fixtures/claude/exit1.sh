#!/bin/sh
# Dies with no rate-limit signal anywhere. Both the first spawn and the corrective resume take
# this path, so the call surfaces the original failure.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-exit1"}'
echo 'something went wrong' >&2
exit 1
