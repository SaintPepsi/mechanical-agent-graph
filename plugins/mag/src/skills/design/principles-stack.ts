import { citation, type ChecklistStep, type Concern } from "mag/skills/design/concern"

export const STEP: ChecklistStep = {
  label: (root) => `Read \`${citation(root, "./principles/index.md")}\``,
  tail: "engineering principles stack (leaf files load just-in-time)"
}

/** The stack is the design's evaluation rubric and the leaf-quoting rule for deviations. Carried
 * for every audience, headless included. The body closes with "Principles inform, not constrain" —
 * nothing else in the prompt tells a run it may explore an approach that brushes a principle before
 * the violation is resolved, and this is the concern that owns what a principle binds. */
export const principlesStack: Concern<"any"> = {
  id: "principles-stack",
  audience: "any",
  steps: [STEP],
  section: {
    heading: "## Engineering Principles Stack",
    body: (root) =>
      `**Read \`${
        citation(root, "./principles/index.md")
      }\` in full before proposing approaches.** It carries every principle's Goal and Rule — the rules are binding from the index alone. Per-principle leaf files under \`${
        citation(root, "./principles/")
      }\` hold the teaching material (why it works, examples, "When This Doesn't Apply").\n\nOpen a leaf file at these moments (not speculatively):\n\n- **Unsure how a principle applies** to an approach — read its examples rather than guessing\n- **Justifying a violation** — see below\n- **Before writing the Principles-applied section** — open the leaf of every principle you cite in it\n\nWhen proposing approaches and presenting the design:\n\n- Evaluate each approach against the relevant principles\n- Call out tradeoffs in principle terms ("Approach B violates Single Source of Truth because…")\n- The final design doc must include a **Principles applied** section listing which principles shaped the design and how\n\nIf a proposed approach violates a principle, you must either (a) justify the violation by opening that principle's leaf file and **quoting the applicable "When This Doesn't Apply" bullet verbatim** in the design doc's Deviations entry, or (b) revise the approach. The index's one-line teaser is not quotable material — a justification that doesn't quote the leaf is not a justification. Don't silently violate principles. Principles inform, not constrain: they exist to surface tradeoffs, not to block exploration.\n\n`
  },
  templateSections: [
    {
      heading: "## Principles Applied",
      body:
        `- **<Principle name>** — how the design honors it\n- **<Principle name>** — how the design honors it\n- **Deviations (if any)** — the principle's "When This Doesn't Apply" bullet, quoted verbatim from its leaf file, plus why it covers this case`
    }
  ]
}
