import type { Concern } from "mag/skills/design/concern"
import { TICKET_TYPES } from "mag/skills/ticket/schema"

/** Reads `TICKET_TYPES` off the schema rather than a second hardcoded list, so the prompt and the
 * decode target can't disagree. */
export const typeComponent: Concern<"any"> = {
  id: "type-component",
  audience: "any",
  section: {
    heading: "Type and component:",
    body: () =>
      [
        `- Type: exactly one of ${TICKET_TYPES.join(", ")}.`,
        "- Component: the path or package each touched area lives in, one entry per area."
      ].join("\n") + "\n\n"
  }
}
