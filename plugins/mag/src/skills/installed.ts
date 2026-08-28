import { join } from "node:path"
import { composeDesignPrompt } from "mag/skills/design/compose"
import { INSTALLED_DESIGN } from "mag/skills/design/variants"
import { DISCOVER_STANDARD } from "mag/skills/recon"
import { RECYCLE_MAP_STANDARD } from "mag/skills/recycle-map"

/**
 * The single home for "where do this checkout's installed skills live, and which variants are
 * materialized." Pure data plus a pure composer, no I/O, no Effect: the `compile-skill` node is the
 * only thing that puts these bytes on disk.
 * A row's `body` calls `composeDesignPrompt`, the same composer `design-graph`'s nodes use, so there
 * is exactly one renderer per concern and nowhere left for the installed document to drift from it.
 */

/** One installed skill: the `---` block's two fields, and a deferred body render, called at dispatch
 * inside the node's own runtime, never at module load. `name` is both the
 * front-matter's and the directory's, one field because a skill loader scans the directory and reads
 * the block: the two cannot be allowed to disagree. Only an installed skill carries front-matter at
 * all, which is why `Variant` has no such field: injected text is never loaded from a directory. */
export interface InstalledSkill {
  readonly name: string
  readonly description: string
  readonly body: () => string
}

/** This checkout's installed skills directory, resolved from this module's own location rather
 * than the process cwd, so it works regardless of where the process was launched from. */
export const SKILLS_ROOT = join(import.meta.dirname, "..", "..", "skills")

/** Which variants are materialized to disk. A second installed skill is a row here, not a second
 * literal path and a second write call inside the node (Data Drives Behavior). */
export const INSTALLED_SKILLS: readonly InstalledSkill[] = [
  {
    name: "brainstorming",
    description:
      "Engineering brainstorming mode for software work — a feature, component, refactor, or architecture decision. USE WHEN brainstorming or designing a feature/component/refactor, choosing between approaches, or thinking through architecture before writing implementation code.",
    body: () => composeDesignPrompt(INSTALLED_DESIGN)
  },
  {
    name: "discover",
    description:
      "Answer one task-agnostic learning question about the codebase before reasoning about a task: reframe the request as \"How does X currently work?\", explore, and write what exists and what's notable to a cited note. USE WHEN asked to discover, recon, or map what already exists for a feature, bug or refactor before designing or planning it, or before building in an unfamiliar area.",
    // The step's own standard (`discover/graph-node.ts` splices the same text) plus the interactive
    // destination the step states through its own write line.
    body: () =>
      [
        DISCOVER_STANDARD,
        "",
        "Write the note to the path the request names, else `docs/graph/discover.md`. Read only; the note is your only write."
      ].join("\n")
  },
  {
    name: "recycle-map",
    description:
      "Map what already exists that a task can reuse, as a cited note: existing modules, components or services that cover part of it, and what is genuinely new with the searches that came up empty. USE WHEN asked what to reuse, what already exists for a feature, or before designing or planning anything a discover note has already mapped.",
    // The step's own standard (`recycle-map/graph-node.ts` splices the same text) plus the
    // interactive destination the step states through its own write line.
    body: () =>
      [
        RECYCLE_MAP_STANDARD,
        "",
        "Read the discover note if the request names one. Write the map to the path the request names, else `docs/graph/recycle-map.md`. Read only; the map is your only write."
      ].join("\n")
  }
]

/** A row's name plus a root becomes its destination. Every installed skill materializes to its own directory's `SKILL.md`. */
export const installedPath = (root: string, name: string): string => join(root, name, "SKILL.md")

/** Puts a row's front-matter over its body — the whole installed document. Pure: no I/O, called
 * inside `compile-skill`'s own runtime, never at module load. */
export const renderInstalled = (skill: InstalledSkill): string =>
  `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body()}`
