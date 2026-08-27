import type { Concern } from "mag/skills/design/concern"

/**
 * The notation-free fallback — a repo matching no probe still envisions, it just picks its own
 * medium; matching nothing is not an error. The discipline every envisioning module teaches is
 * unchanged; only the notation is not pre-decided for a stack this pipeline doesn't know.
 */
export const envisionGeneric: Concern<"any"> = {
  id: "envision-generic",
  audience: "any",
  section: {
    heading: "",
    body: () =>
      `Pick the notation the change actually deserves — prose, a diagram, pseudo-code, whatever draws the idea without prescribing its file layout — and name which one in the design. The discipline is unchanged: draw the ideal shape of the built thing, imagined as if from nothing — what exists today has no vote.\n\n`
  }
}
