import type { Concern } from "mag/skills/design/concern"

/** Interactive only: it asks for an approval a headless dispatch cannot receive. `design/graph-node.ts`'s
 * `agent.prompt` call dispatches once and reads a file back. There is no channel on which a question
 * could be asked or an approval received. Carries `preamble`'s old scope disclaimer too — both are
 * the interactive gate on proceeding, one on starting at all when the work isn't code, the other on
 * building before approval, so they belong under one heading rather than two. */
export const hardGate: Concern<"interactive"> = {
  id: "hard-gate",
  audience: "interactive",
  section: {
    heading: "",
    body: () =>
      "If the work is **not** primarily code (article, talk, naming, life decision), this engineering mode isn't the right fit — stop and brainstorm it conversationally instead.\n\n" +
      "<HARD-GATE>\nDo NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.\n</HARD-GATE>\n\n"
  }
}
