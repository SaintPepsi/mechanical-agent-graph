import { Effect, Schema } from "effect"
import { fetchTicket } from "mag/graph-nodes/fetch-ticket/graph-node"
import { formatBranchNameNode } from "mag/graph-nodes/format-branch-name/graph-node"
import { make } from "mag/runtime/graph-node.definition"

// Per-repo policy: who fetch-ticket trusts as maintainer-authored text.
const MAINTAINER = "SaintPepsi"

/**
 * A ticket id in, the branch name that ticket should use out.
 *
 * It is the opening two nodes of the pipeline, stopping before `branch` — nothing here checks
 * anything out. That fence is deliberate: this exists to make composition real, not to reach the
 * first run early.
 *
 * Three things it settles by doing rather than by arguing:
 *
 * 1. **Composition is a direct `run` call, not `execute`.** `execute` decodes untrusted input first;
 *    in-process composition already has typed values, and re-decoding what the type system proved
 *    is ceremony paid per node per run.
 * 2. **The transform between the nodes is visible, in the graph file, on purpose.** The two schemas
 *    nearly line up: `fetch-ticket` yields `{ ticket, title, ticketPath }` and `format-branch-name`
 *    wants `{ ticket, title, labels? }`. `ticketPath` is dropped and `labels` has no producer, so the
 *    pipe is not straight, and the seam shows where a node is asking for something no node makes.
 * 3. **A graph wears the GraphNode shape.** Node, phase and graph are the same shape at every level,
 *    which is also what lets the existing registry run this with no graph-runner subsystem invented
 *    for it.
 *
 * Labels are the honest gap. `fetch-ticket`'s success shape carries title and ticket path only, so
 * `branchType` never sees a label and every branch this graph names comes out `feat/`.
 * Closing it needs a tracker verb that does not exist yet, and inventing one here would be building
 * ahead of a graph that has asked for it.
 */
export const branchName = make({
  name: "branch-name",
  description: "Fetch a ticket and compute the branch name it should use.",
  input: Schema.Struct({ ticket: Schema.String }),
  // `ticketPath` is minted and deliberately not carried: nothing downstream of here consumes it yet.
  success: Schema.Struct({ ticket: Schema.String, title: Schema.String, branch: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const ticket = yield* fetchTicket.run({ ticket: input.ticket, maintainer: MAINTAINER })
      const { branch } = yield* formatBranchNameNode.run({
        ticket: ticket.ticket,
        title: ticket.title,
        labels: []
      })
      return { ticket: ticket.ticket, title: ticket.title, branch }
    })
})
