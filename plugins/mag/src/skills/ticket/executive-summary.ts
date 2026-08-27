import type { Concern } from "mag/skills/design/concern"

export const executiveSummary: Concern<"any"> = {
  id: "executive-summary",
  audience: "any",
  section: {
    heading: "Executive summary:",
    body: () => "- One line: what this delivers and why, detail goes in the context.\n\n"
  }
}
