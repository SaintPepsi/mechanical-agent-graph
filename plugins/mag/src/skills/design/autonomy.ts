import type { Concern } from "mag/skills/design/concern"

/**
 * An autonomous run can stall waiting for an approval nobody will give: the dispatch is
 * `agent.prompt` with a JSON schema (`design/graph-node.ts`), there is no question channel, and
 * the prompt would otherwise open with a hard gate demanding user approval. This concern takes the
 * checklist slot that `clarifying-questions` and `dialogue-norms` vacate in the headless variant.
 *
 * Scoped to `Concern<"headless">`, not `"any"` — a human is in the room for `INSTALLED_DESIGN`, so
 * telling that session "no user is watching this run" would contradict `hard-gate`'s approval wait in
 * the same document. The audience gate makes listing this concern there a compile error.
 */
export const autonomy: Concern<"headless"> = {
  id: "autonomy",
  audience: "headless",
  section: {
    heading: "## Autonomy",
    body: () =>
      "No user is watching this run and there is no channel to ask one. Take the broadest reasonable interpretation of any ambiguity and record the reading under **Interpretation Rulings** with its basis. Where the ticket gives none, the basis is the existing behaviour, kept. Every choice is made in this pass.\n\n"
  }
}
