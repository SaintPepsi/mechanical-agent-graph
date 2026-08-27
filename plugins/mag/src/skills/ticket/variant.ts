import type { Concern } from "mag/skills/design/concern"
import { acceptanceCriteria } from "mag/skills/ticket/acceptance-criteria"
import { context } from "mag/skills/ticket/context"
import { dependsBlocks } from "mag/skills/ticket/depends-blocks"
import { executiveSummary } from "mag/skills/ticket/executive-summary"
import { graphNodes } from "mag/skills/ticket/graph-nodes"
import { style } from "mag/skills/ticket/style"
import { typeComponent } from "mag/skills/ticket/type-component"

/**
 * The ordered list below is the only place the ticket standard's shape is authored. Adding a
 * concern is a module plus a line here, never an edit to another concern's prose or to
 * `compose.ts`'s renderer, which knows no concern names.
 */
export const TICKET_STANDARD: readonly Concern<"any">[] = [
  executiveSummary,
  typeComponent,
  context,
  acceptanceCriteria,
  dependsBlocks,
  graphNodes,
  style
]
