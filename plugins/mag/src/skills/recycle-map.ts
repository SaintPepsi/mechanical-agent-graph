import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * Single home for the recycle-map node's destination, `recon.ts`'s `DISCOVER_DESTINATION` shape:
 * the write instruction the node splices into the prompt and its own path composer both read this.
 */
export const RECYCLE_MAP_DESTINATION = `docs/graph/${TICKET_TOKEN}/recycle-map.md`

/**
 * The reuse question, in the discover voice: one question, two lists, every claim cited. The
 * single source for the step's prompt (`recycle-map/graph-node.ts`) and the installed
 * `recycle-map` skill (`installed.ts`), so the two cannot drift; the step prefixes the ticket and
 * discover references and its write line, the skill its interactive destination.
 */
export const RECYCLE_MAP_STANDARD = `# Recycle map

Answers the question: "What already exists that this task can reuse?"

Search from the ticket's own nouns and their case variants (kebab/camel/snake/Pascal) and synonyms. Cite every claim with a repo-relative path or path:line. The map is your only write.

## Execution

1. Reframe the task as the reuse question ("What already exists that this task can reuse?")
2. Search: the ticket's nouns, the discover note's files, the modules beside them
3. Write the map: the question first, then two lists

## Reuse

Existing modules, components, or services that already cover part of the ticket, each cited by name and path with the part it covers.

## Genuinely new

Each entry names the searches that came up empty for it and where they were run.`

/** The step's copy of the standard, compiled inside the node's own runtime at dispatch. */
export const compileRecycleMap = (): string => RECYCLE_MAP_STANDARD
