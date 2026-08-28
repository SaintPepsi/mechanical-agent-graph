import { Effect, FileSystem, Schema } from "effect"
import { DesignRulingsUnreadable, DesignRulingsWriteFailed } from "mag/graph-nodes/design-rulings/errors"
import { interpretationRulingsSection } from "mag/graph-nodes/design-rulings/section"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { RunInfo } from "mag/runtime/run-info"

/** The comment as a tracker reader meets it: what the rulings are, where they came from, then the rows. */
const renderComment = (ticket: string, prUrl: string, rulings: string): string =>
  [
    `Interpretation rulings from the design behind ${prUrl}, for ${ticket}. Each row is a reading the design committed to where the ticket allowed more than one; a row with the wrong basis is a correction to make on this ticket.`,
    "",
    rulings
  ].join("\n")

/**
 * The tracker is the only writable copy of ticket truth: a ruling that changes what the ticket
 * means is posted back, so a reader of the ticket sees what a reader of the run record sees. This
 * node is the mechanical half of that post, `comment-ticket`'s precedent: one file read, the
 * section lifted by the heading the design template authored, one run-root file for
 * `comment-ticket` to post. No model session. A design that ruled on nothing yields no path, and
 * the graph posts nothing.
 */
export const designRulings = make({
  name: "design-rulings",
  description: "Lift the design record's Interpretation Rulings into a run-root comment body, or none when it ruled on nothing.",
  input: Schema.Struct({
    ticket: Schema.String,
    designPath: Schema.String,
    /** The PR the rulings shipped behind, so the comment cites where the design's choices landed. */
    prUrl: Schema.String
  }),
  success: Schema.Struct({
    /** Absent when the design carries no ruling: the section is missing, empty, or the template's own placeholder. */
    rulingsPath: Schema.optional(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const runInfo = yield* RunInfo
      yield* requireRunRoot(() => new DesignRulingsWriteFailed({ runRoot: "", detail: "run root missing" }))

      const design = yield* fs.readFileString(input.designPath).pipe(
        Effect.mapError((error) => new DesignRulingsUnreadable({ path: input.designPath, detail: String(error) }))
      )
      const rulings = interpretationRulingsSection(design)
      if (rulings === undefined) return {}

      const rulingsPath = yield* writeArtifact(fs, runInfo.runRoot, "design-rulings", renderComment(input.ticket, input.prUrl, rulings)).pipe(
        Effect.catch((error) => Effect.fail(new DesignRulingsWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) })))
      )
      return { rulingsPath }
    }).pipe(Effect.provide(platform))
})
