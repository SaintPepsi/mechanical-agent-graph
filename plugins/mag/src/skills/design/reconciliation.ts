import type { Concern } from "mag/skills/design/concern"

/**
 * The brainstorm variant's own concern, spliced into the slot the envisioning modules occupy for
 * the headless design variant (`variants.ts`). This dispatch draws no shell itself — the shells
 * already exist as committed per-notation vision documents — so its whole job is joining them to
 * discover's recon rather than repeating what drew them.
 */
export const reconciliation: Concern<"any"> = {
  id: "reconciliation",
  audience: "any",
  section: {
    heading: "",
    body: () =>
      `Each notation's vision document is the shell: cite it by path, and do not redraw it — the Seams ` +
      `& Ownership table is what joins the visions to each other and to discover's recon. Where a vision ` +
      `element collides with something discover found under a similar name but a different shape, record ` +
      `the resolution in "Vision Reconciliation" below. Nothing is silently renamed or reused.\n\n`
  },
  templateSections: [
    {
      heading: "## Vision Reconciliation",
      body:
        "<!-- every collision between a vision element and something discover found under a similar name\n     but a different shape, and how it was resolved -->"
    }
  ]
}
