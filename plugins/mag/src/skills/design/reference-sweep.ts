import type { Concern } from "mag/skills/design/concern"

/** Single home for what counts as a retirement: the design brief and `review-diff`'s gate both read
 * this, so they cannot disagree. */
export const SWEEP_TRIGGER = "retires a ruling, renames a contract, or moves a file"

/** Single home for the sweep record's name: what the design brief writes and the gate looks for. */
export const SWEEP_LABEL = "Reference Sweep"

/** `review-diff` gates on this today (`review-diff/graph-node.ts`'s `SWEEP_GATE`), so cutting it would break a
 * live gate. Carried for every audience, headless included. Its section has no heading of its own:
 * the paragraph continues `seams-ownership`'s `## The Envisioned Shell`, which is where the sweep
 * obligation sits in the document today. */
export const referenceSweep: Concern<"any"> = {
  id: "reference-sweep",
  audience: "any",
  section: {
    heading: "",
    body: () =>
      `A design that ${SWEEP_TRIGGER} records a **${SWEEP_LABEL}** alongside that table: the repo-wide grep you ran for the old name, docs included, and every hit it returned, each hit either owned by an edit this change makes or carrying a one-line reason its wording stays (frozen historical records keep theirs).\n\n`
  },
  templateSections: [
    {
      heading: `## ${SWEEP_LABEL}`,
      body:
        `Present when the change ${SWEEP_TRIGGER}: the grep command run, then one row per hit.\n\n| Hit | Owned by / reason its wording stays |\n| --- | --- |`
    }
  ]
}
