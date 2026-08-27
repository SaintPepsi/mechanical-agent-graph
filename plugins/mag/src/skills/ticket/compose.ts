import { renderSection } from "mag/skills/design/compose"
import type { Concern } from "mag/skills/design/concern"

/**
 * Pure: concerns in, one string out. No parsing, no I/O, no dispatch-time facts. The ticket standard
 * cites nothing outside itself, so every section renders against a `null` citation root.
 * Composer-owned, knows no concern's name or content, the same contract `design/compose.ts`'s own
 * `composeDesignPrompt` keeps.
 */
export const compileTicketStandard = (concerns: readonly Concern<"any">[]): string =>
  "Write the ticket's structure under this standard.\n\n" +
  concerns.map((concern) => renderSection(null, concern.section!)).join("")
