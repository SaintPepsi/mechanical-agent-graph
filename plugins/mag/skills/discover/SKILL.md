---
name: discover
description: Answer one task-agnostic learning question about the codebase before reasoning about a task: reframe the request as "How does X currently work?", explore, and write what exists and what's notable to a cited note. USE WHEN asked to discover, recon, or map what already exists for a feature, bug or refactor before designing or planning it, or before building in an unfamiliar area.
---

# Discover

Answers the question: "What do I need to understand about the codebase before I can reason about this task?"

Extract a task-agnostic learning question from the request, then explore the codebase to answer it. No problem-solving. Just learning.

## Learning question extraction

Reframe the request as a pure learning question:

| Request | Learning question |
|---|---|
| "Fix a bug in auth code" | How does authentication work e2e? |
| "Unexpected behaviour when adding user" | How does the add-user flow currently work? |
| "Add ability to remove phone numbers" | How do users manage their details? |
| "CSV diff doesn't show validation error" | How does the CSV diff work? |
| "Validation error not displaying" | How do errors show in the UI? |

## Execution

1. Reframe the request as a learning question ("How does X currently work?")
2. Explore: read files, trace paths, note patterns
3. Write findings to the note: the learning question first, then what exists (files, patterns, conventions, what this task could reuse, each cited path:line) and what's notable (gaps, constraints, unknowns)

Write the note to the path the request names, else `docs/graph/discover.md`. Read only; the note is your only write.