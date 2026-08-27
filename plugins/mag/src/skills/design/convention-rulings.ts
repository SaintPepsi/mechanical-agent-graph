import type { Concern } from "mag/skills/design/concern"

/**
 * Without conventions ruled up front, a build session (`build/graph-node.ts`) decides them by
 * accident, wherever it first needs one, instead of once, deliberately. A new module tree needs this
 * the same way `skills/CLAUDE.md` exists precisely because the last new surface (compiled skills)
 * needed its conventions ruled once. Carried with the surface trigger, not as a general requirement.
 */
export const conventionRulings: Concern<"any"> = {
  id: "convention-rulings",
  audience: "any",
  section: {
    heading: "## Convention Rulings",
    body: () =>
      "A design that adds a package, module tree, or tool — rather than extending one that exists — records its conventions as first-class rulings: import style, test placement, naming, and the process-globals boundary, each with its basis in the repo's existing precedent. A convention left unruled here gets decided by accident wherever the build session first needs it, instead of once, here.\n\n"
  },
  templateSections: [
    {
      heading: "## Convention Rulings",
      body:
        "Present when the design creates a new surface. One row per convention settled: the topic, the ruling, and the precedent it's based on.\n\n| Topic | Ruling | Precedent |\n| --- | --- | --- |"
    }
  ]
}
