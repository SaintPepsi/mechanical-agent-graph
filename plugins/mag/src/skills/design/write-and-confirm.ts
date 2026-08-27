import type { ChecklistStep, Concern } from "mag/skills/design/concern"
import { TICKET_TOKEN } from "mag/skills/design/tokens"

/** Single home for the design node's destination: the checklist's write step and `graph-node.ts`'s
 * own path composer both read this, so they cannot disagree. */
export const DESIGN_DESTINATION = `docs/graph/${TICKET_TOKEN}/design.md`

/** The ticket-filled value, read back out here rather than re-filled by each node that composes a
 * design path (`design`/`brainstorm`, the two lanes that must not disagree). */
export const designDestinationFor = (ticket: string): string => DESIGN_DESTINATION.replaceAll(TICKET_TOKEN, ticket)

const writeStep: ChecklistStep = {
  label: () => "Write design doc",
  tail: `to \`${DESIGN_DESTINATION}\`, including "Envisioned Shell", "Seams & Ownership", and "Principles applied" sections`
}

/**
 * No git instruction: the node that dispatched this session checks the file at the destination,
 * copies it into the run root, and commits the repo copy only when this repository's own policy
 * says so (`record`, `runtime/records.ts`) — a session that also ran `git add`/`git commit` would
 * race the node's own scoped commit over the same path. Names the same destination the write step
 * does, so `design`/`brainstorm`'s one substitution still rewrites both.
 */
const confirmStep: ChecklistStep = {
  label: () => "Confirm the design doc",
  tail:
    `the file at \`${DESIGN_DESTINATION}\` is written and non-empty. The node checks it and copies ` +
    `it into the run record; whether it is also committed is the repository's policy, not yours: do not run git`
}

/** Identical in every variant: a headless dispatch and an interactive session end the same way. */
const returnStep: ChecklistStep = {
  label: () => "Return",
  tail:
    "the design doc you wrote is this skill's terminal artifact. Do NOT invoke any implementation skill; planning and execution belong to the caller."
}

/** The node's mechanical check reads this same constant (`design/graph-node.ts`'s
 * `designDestinationFor` call). Carried for
 * every audience, headless included: `INSTALLED_DESIGN` renders the same deterministic destination a
 * pipeline dispatch does, so a human-led design lands its artifact exactly where the lane's own
 * write step does, with no invoker-named or dated variant for an editor step to special-case. */
export const writeAndConfirm: Concern<"any"> = {
  id: "write-and-confirm",
  audience: "any",
  steps: [writeStep, confirmStep, returnStep]
}
