import type { Concern } from "mag/skills/design/concern"

/**
 * A backlog for deferred improvements is where good ideas go to rot: nothing in this pipeline's
 * review or simplify passes ever revisits one. So an improvement noticed at design time has
 * nowhere to land except decided now, in the same run — this module states that rule directly
 * rather than naming an artifact that doesn't exist yet.
 */
export const improvements: Concern<"any"> = {
  id: "improvements",
  audience: "any",
  section: {
    heading: "## Improvements",
    body: () =>
      "An improvement you notice while designing is decided now, not deferred: build it in this same run, never file it as a follow-up ticket. A backlog entry is where an improvement goes to rot.\n\n"
  }
}
