import { Effect, Schema } from "effect"
import { branch } from "mag/graph-nodes/branch/graph-node"
import { detectConflicts } from "mag/graph-nodes/detect-conflicts/graph-node"
import { pushBranch } from "mag/graph-nodes/push-branch/graph-node"
import { resolveBase } from "mag/graph-nodes/resolve-base/graph-node"
import { resolveConflicts } from "mag/graph-nodes/resolve-conflicts/graph-node"
import { worktreeAdd } from "mag/graph-nodes/worktree-add/graph-node"
import { worktreeRemove } from "mag/graph-nodes/worktree-remove/graph-node"
import { graph } from "mag/runtime/graph"

/** Per-repository policy, this graph's own declared constants — `develop-graph`'s own convention. */
const BASE_BRANCH = "main"
const VERIFICATION_COMMAND = "bun run typecheck && bun run test"
const WORKTREE_SETUP = "bun install --frozen-lockfile"
const REMOTE = "origin"

/**
 * The resolver's standing brief lives in the agent file (`.claude/agents/merge-conflict-resolver.md`);
 * hardwired here the way `develop-graph` hardwires `effect-expert`, because this graph exists for
 * exactly the sessions that need it.
 */
const RESOLVER_AGENT = "merge-conflict-resolver"

/**
 * Judgment-heavy work gets the stronger model. A conflict resolver has neither a
 * design nor a test encoding the two authors' intent, and picking wrong silently discards someone's
 * work — Opus, not Sonnet.
 */
const MODEL_RESOLVE = "opus"

/** The gating `detect-conflicts` call verifies both refs before any worktree exists; its result is discarded because `resolve-conflicts` owns detection for real with its own fresh call. */
const pipeline = (ticket: string, target: string, requestedBase: string) =>
  Effect.gen(function* () {
    const resolvedBase = yield* resolveBase.run({ base: requestedBase, remote: REMOTE })
    yield* detectConflicts.run({ base: resolvedBase.base, target })

    const tree = yield* worktreeAdd.run({ base: resolvedBase.base, setup: WORKTREE_SETUP })
    yield* branch.run({ branch: target, base: resolvedBase.base })

    const outcome = yield* resolveConflicts.run({
      base: resolvedBase.base,
      target,
      command: VERIFICATION_COMMAND,
      agent: RESOLVER_AGENT,
      model: MODEL_RESOLVE
    })

    // pushBranch's own guards hold by construction here: the tree is clean because resolve-conflicts's
    // own commit step ran (only once the declared suite passed against the staged tree), and the
    // branch is ahead of base because a merge commit was just added to it.
    if (outcome.resolved) {
      yield* pushBranch.run({ remote: REMOTE, branch: target, base: resolvedBase.base })
    }

    yield* worktreeRemove.run({ path: tree.path })

    return {
      ticket,
      target,
      base: resolvedBase.base,
      conflicts: outcome.conflicts,
      resolved: outcome.resolved,
      headSha: outcome.headSha,
      sessions: outcome.sessions,
      costUsd: outcome.costUsd,
      pushed: outcome.resolved
    }
  })

/**
 * conflict-graph: a graph that resolves merge conflicts, standalone (the brief's narrower start —
 * not a develop-graph tail). `ticket` is the run's identity (keys the run root, the journal stamp,
 * `RunScope`); `target` is the run's subject, kept separate because a conflict run may point at the
 * same branch more than once and deriving it from the ticket would tie this graph to develop-graph's
 * naming scheme for no gain.
 *
 * `RunScope.worktree` is declared `true`, unconditionally: a node that produces conflict markers in
 * a tree must never do it in the maintainer's primary checkout.
 */
export const conflictGraph = graph({
  name: "conflict-graph",
  description: "Detect a merge conflict between base and target, resolve it under the declared suite, push when resolved.",
  input: Schema.Struct({
    ticket: Schema.String,
    target: Schema.String,
    base: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    ticket: Schema.String,
    target: Schema.String,
    base: Schema.String,
    conflicts: Schema.Array(Schema.String),
    resolved: Schema.Boolean,
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    pushed: Schema.Boolean
  }),
  scope: (input) => ({ ticket: input.ticket, graph: "conflict-graph", worktree: true }),
  pipeline: (input) => pipeline(input.ticket, input.target, input.base ?? BASE_BRANCH)
})
