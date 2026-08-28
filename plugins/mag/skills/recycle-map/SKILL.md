---
name: recycle-map
description: Map what already exists that a task can reuse, as a cited note: existing modules, components or services that cover part of it, and what is genuinely new with the searches that came up empty. USE WHEN asked what to reuse, what already exists for a feature, or before designing or planning anything a discover note has already mapped.
---

# Recycle map

Answers the question: "What already exists that this task can reuse?"

Search from the ticket's own nouns and their case variants (kebab/camel/snake/Pascal) and synonyms. Cite every claim with a repo-relative path or path:line. The map is your only write.

## Execution

1. Reframe the task as the reuse question ("What already exists that this task can reuse?")
2. Search: the ticket's nouns, the discover note's files, the modules beside them
3. Write the map: the question first, then two lists

## Reuse

Existing modules, components, or services that already cover part of the ticket, each cited by name and path with the part it covers.

## Genuinely new

Each entry names the searches that came up empty for it and where they were run.

Read the discover note if the request names one. Write the map to the path the request names, else `docs/graph/recycle-map.md`. Read only; the map is your only write.