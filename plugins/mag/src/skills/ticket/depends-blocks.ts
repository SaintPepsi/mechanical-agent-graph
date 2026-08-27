import type { Concern } from "mag/skills/design/concern"

export const dependsBlocks: Concern<"any"> = {
  id: "depends-blocks",
  audience: "any",
  section: {
    heading: "Depends/blocks:",
    body: () =>
      "- State what this ticket depends on and what it blocks, \"nothing\" when there is none, never an omitted field.\n\n"
  }
}
