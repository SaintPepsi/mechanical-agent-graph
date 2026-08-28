import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * Single home for the discover node's destination: the write instruction the node splices into the
 * prompt (`discover/graph-node.ts`'s `promptFor`) and the node's own path composer both read this,
 * so they cannot disagree — `write-and-confirm.ts`'s `DESIGN_DESTINATION` precedent. `TICKET_TOKEN` is
 * imported rather than restated, the way `write-pr-body` already imports it.
 */
export const DISCOVER_DESTINATION = `docs/graph/${TICKET_TOKEN}/discover.md`

/**
 * The maintainer's discover phase, verbatim: one task-agnostic learning question, answered by
 * exploring, reported as what exists and what's notable. The single source for the step's prompt
 * (`discover/graph-node.ts`) and the installed `discover` skill (`installed.ts`), so the two cannot
 * drift; the step prefixes the ticket reference and its write line, the skill its interactive
 * destination.
 */
export const DISCOVER_STANDARD = `# Discover

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
3. Write findings to the note: the learning question first, then what exists (files, patterns, conventions, each cited path:line) and what's notable (gaps, constraints, unknowns)`

/** The step's copy of the standard, compiled inside the node's own runtime at dispatch. */
export const compileRecon = (): string => DISCOVER_STANDARD
