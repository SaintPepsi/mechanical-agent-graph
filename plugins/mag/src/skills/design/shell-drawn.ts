import type { Concern } from "mag/skills/design/concern"

/**
 * The brainstorm variant's own concern, spliced into the slot the envisioning modules occupy for
 * the headless design variant (`variants.ts`). This dispatch draws no shell itself: the same
 * session drew it blind, into the design doc, before the recon was read, so its whole job here is
 * completing the design around that section rather than repeating what drew it. No template
 * section of its own: the shell lives in `seams-ownership`'s "Envisioned Shell" section, already
 * in the file.
 */
export const shellDrawn: Concern<"any"> = {
  id: "shell-drawn",
  audience: "any",
  section: {
    heading: "",
    body: () =>
      `The Envisioned Shell section already stands in the design doc, drawn before this pass read the ` +
      `repo: keep it as drawn, and fill the Seams & Ownership table against it and discover's recon. ` +
      `Where a shell element and something discover found share a name but not a shape, rule on it in ` +
      `Interpretation Rulings, naming both.\n\n`
  }
}
