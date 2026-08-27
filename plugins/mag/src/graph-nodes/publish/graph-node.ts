import { Effect, Schema } from "effect"
import { createPr } from "mag/graph-nodes/create-pr/graph-node"
import { pushBranch } from "mag/graph-nodes/push-branch/graph-node"
import { make } from "mag/runtime/graph-node.definition"

/**
 * `publish` composes `push-branch` and `create-pr`, both already-journaled nodes, through
 * `make()` itself. `journaled` wraps any made node and appends one row per run, nested or not — a node,
 * a phase and a graph are the same shape, so `publish` is built the same way `conflictGraph`
 * already is: a node whose own `run` is nothing but other nodes' `.run()` calls.
 *
 * `remote`/`host`/`slug`/`base`/`title` all arrive as input: no repo fact is a literal
 * here. `success` is `createPr.success` itself, reused rather than redefined, so there is no second
 * schema to drift from the first.
 *
 * `body` is a required input, forwarded to `create-pr` unchanged — `publish` is a
 * pass-through composite, so it decorates nothing and defaults nothing; deciding what the body says
 * is the calling graph's business (`runtime/pr-body.ts`).
 */
export const publish = make({
  name: "publish",
  description: "Push the branch, then open its pull/merge request.",
  input: Schema.Struct({
    remote: Schema.String,
    branch: Schema.String,
    host: Schema.String,
    slug: Schema.String,
    base: Schema.String,
    title: Schema.String,
    body: Schema.String
  }),
  success: createPr.success, // publish's whole output IS create-pr's output, unchanged
  run: (input) =>
    Effect.gen(function* () {
      const pushed = yield* pushBranch.run({ remote: input.remote, branch: input.branch, base: input.base })
      return yield* createPr.run({
        host: input.host,
        slug: input.slug,
        base: input.base,
        source: pushed.branch,
        title: input.title,
        body: input.body
      })
    })
})
