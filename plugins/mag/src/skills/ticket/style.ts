import type { Concern } from "mag/skills/design/concern"

export const style: Concern<"any"> = {
  id: "style",
  audience: "any",
  section: {
    heading: "Style:",
    body: () =>
      [
        "- No em-dashes: use a period, a colon, or a comma.",
        "- State what the ticket includes, never an exclusions or out-of-scope list."
      ].join("\n") + "\n\n"
  }
}
