#!/bin/sh
# A schemaless reply with the object buried in prose and fences.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-prose"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-prose","total_cost_usd":0.5,"result":"Here you go:\n```json\n{\"status\":\"pass\"}\n```\nHope that helps."}'
