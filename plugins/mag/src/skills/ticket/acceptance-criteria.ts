import type { Concern } from "mag/skills/design/concern"

export const acceptanceCriteria: Concern<"any"> = {
  id: "acceptance-criteria",
  audience: "any",
  section: {
    heading: "Acceptance criteria:",
    body: () =>
      [
        "- Gherkin form: a title, one GIVEN, one WHEN, and one or more THEN outcomes.",
        "- Include at least one disconfirming criterion, whose GIVEN or WHEN names a case that must NOT pass.",
        "- Carry a provided sentence verbatim in its criterion's `source` field; a criterion you add beyond the provided list carries no `source`."
      ].join("\n") + "\n\n"
  }
}
