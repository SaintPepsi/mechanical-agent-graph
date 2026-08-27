import type { Concern } from "mag/skills/design/concern"

/** Distinct from `executive-summary`'s one line: this is where the background that line has no room for goes. */
export const context: Concern<"any"> = {
  id: "context",
  audience: "any",
  section: {
    heading: "Context:",
    body: () =>
      "- State what exists today and why it falls short, the background the executive summary has no room for, readable cold with no memory of this conversation.\n\n"
  }
}
