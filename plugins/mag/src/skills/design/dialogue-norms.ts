import type { ChecklistStep, Concern } from "mag/skills/design/concern"

export const STEP: ChecklistStep = { label: () => "Present design", tail: "sections scaled to complexity, incremental approval" }

/** Interactive only: all four of its fragments pace a conversation nobody is having in a headless run.
 * The pacing rules and the message-length cap have no other home in the concern split, so they
 * become this concern's own `section`. Heading empty: `INSTALLED_DESIGN` lists this concern
 * immediately after `design-doc-template`, so its body continues that concern's own
 * `## Presenting the Design` heading rather than opening a second one. */
export const dialogueNorms: Concern<"interactive"> = {
  id: "dialogue-norms",
  audience: "interactive",
  steps: [STEP],
  section: {
    heading: "",
    body: () =>
      "Ask after each section whether it looks right, and be ready to revise. Cap dialogue messages around 6-10 lines unless presenting a full design: present, approve, then move on.\n\n"
  }
}
