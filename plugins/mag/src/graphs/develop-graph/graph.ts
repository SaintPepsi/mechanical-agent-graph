import { Effect, Schema } from "effect"
import { branch } from "mag/graph-nodes/branch/graph-node"
import { buildUnderReview } from "mag/graph-nodes/build-under-review/graph-node"
import { createPr } from "mag/graph-nodes/create-pr/graph-node"
import { fetchTicket } from "mag/graph-nodes/fetch-ticket/graph-node"
import { formatBranchNameNode } from "mag/graph-nodes/format-branch-name/graph-node"
import { promptTersenessEvaluator } from "mag/graph-nodes/prompt-terseness-evaluator/graph-node"
import { pushBranch } from "mag/graph-nodes/push-branch/graph-node"
import { requireAcs } from "mag/graph-nodes/require-acs/graph-node"
import { resolveBase } from "mag/graph-nodes/resolve-base/graph-node"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { worktreeAdd } from "mag/graph-nodes/worktree-add/graph-node"
import { worktreeRemove } from "mag/graph-nodes/worktree-remove/graph-node"
import { writePrBody } from "mag/graph-nodes/write-pr-body/graph-node"
import { designGraph } from "mag/graphs/design-graph/graph"
import { Graph } from "mag/runtime/construct"
import { prBody } from "mag/runtime/pr-body"

// This repository's own declared per-repo defaults.
const BASE_BRANCH = "main"
const VERIFICATION_COMMAND = "bun run typecheck && bun run test"
const WORKTREE_SETUP = "bun install --frozen-lockfile"
const MAINTAINER = "SaintPepsi"
const REMOTE = "origin"
const HOST = "github.com"
const SLUG = "SaintPepsi/mechanical-agent-graph"
const EFFECT_AGENT = "effect-expert"

// Pipeline policy: varies by node judgment, not by target repository, so it stays a constant rather than an input field.
const REVIEW_CAP = 2
const MODEL_DESIGN = "opus"
const MODEL_BUILD = "sonnet"
const MODEL_SIMPLIFY = "opus"
const MODEL_REVIEW = "opus"

const RECORDS_POLICIES = ["run-root", "committed"] as const
type RecordsPolicy = (typeof RECORDS_POLICIES)[number]
const isRecordsPolicyCheck = Schema.makeFilter<string>(
  (value) => ((RECORDS_POLICIES as readonly string[]).includes(value) ? undefined : `expected ${RECORDS_POLICIES.join(" or ")}`),
  { expected: RECORDS_POLICIES.join(" or ") }
)

const input = Schema.Struct({
  ticket: Schema.String,
  base: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.Boolean),
  resume: Schema.optional(Schema.Boolean),
  verification: Schema.optional(Schema.String),
  worktreeSetup: Schema.optional(Schema.String),
  remote: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  maintainer: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  /**
   * `"run-root"` or `"committed"` (`RunInfoService.records`'s own doc). A checked `Schema.String`,
   * not `Schema.Literal`: `schema-flags.ts` derives a CLI flag for string/number/boolean only, and a
   * check hangs off the primitive so the flag still derives while the decode at the CLI boundary
   * enforces the two values — an unfit value dies before any node runs.
   */
  records: Schema.optional(Schema.String.check(isRecordsPolicyCheck))
})
type Input = typeof input.Type

/**
 * The only site any per-repo default is read: `scope` and `seed` below both call it on the same
 * `input`, so they cannot resolve `worktree` two different ways. A plain function, not an Effect, so
 * every default and every override is testable with no shell.
 */
export const resolvePolicy = (input: Input) => ({
  base: input.base ?? BASE_BRANCH,
  worktree: input.worktree ?? true,
  resume: input.resume ?? false,
  verification: input.verification ?? VERIFICATION_COMMAND,
  worktreeSetup: input.worktreeSetup ?? WORKTREE_SETUP,
  remote: input.remote ?? REMOTE,
  host: input.host ?? HOST,
  slug: input.slug ?? SLUG,
  maintainer: input.maintainer ?? MAINTAINER,
  agent: input.agent ?? EFFECT_AGENT,
  // The cast is honest: `input`'s check already refused anything but the two values at decode.
  records: (input.records ?? "run-root") as RecordsPolicy
})

/**
 * The rail-sketch's `Prepare`: `resolve-base` ∥ `fetch-ticket`, gated by `require-acs`, joined by
 * `format-branch-name`. Everything here runs before any worktree exists, so an uncaught failure dies
 * with nothing kept — and before any model session, so a base that doesn't resolve still costs no
 * agent spend. The gate refuses before anything downstream spends: a missing-ACs ticket is a
 * conversation to have with the maintainer, not a gap this pipeline fills. Its success is
 * discarded: downstream reads `ticketPath` straight off `fetch-ticket`'s own success.
 */
const prepare = Graph.construct<{ ticket: string; base: string; remote: string; maintainer: string }>("prepare")
  .fork(
    resolveBase, (s) => ({ base: s.base, remote: s.remote }),
    fetchTicket, (s) => ({ ticket: s.ticket, maintainer: s.maintainer })
  )
  .thenKeep(requireAcs, (s) => ({ ticket: s.ticket, title: s.title, ticketPath: s.ticketPath }), () => ({}))
  .join(formatBranchNameNode, (s) => ({ ticket: s.ticket, title: s.title, labels: [] }))
  .finalise({
    description: "Resolve the base and fetch the ticket in parallel, then compute the branch name.",
    input: Schema.Struct({
      ticket: Schema.String,
      base: Schema.String,
      remote: Schema.String,
      maintainer: Schema.String
    }),
    success: Schema.Struct({
      base: Schema.String,
      ticket: Schema.String,
      title: Schema.String,
      ticketPath: Schema.String,
      branch: Schema.String
    }),
    scope: (input) => ({ ticket: input.ticket, graph: "prepare", worktree: false }),
    seed: (input) => input,
    out: (s) => ({ base: s.base, ticket: s.ticket, title: s.title, ticketPath: s.ticketPath, branch: s.branch })
  })

/**
 * The rail-sketch's `Checkout`: `worktree-add` when the run wants a worktree (the default), then the
 * resume-safe branch checkout. `path` is present exactly when a worktree was materialized — the
 * `worktree = false` shape operates on the primary checkout and has no path to retire later.
 * From here on an uncaught failure dies with the worktree kept, for a human.
 */
const checkout = Graph.construct<{
  ticket: string
  base: string
  branch: string
  worktree: boolean
  worktreeSetup: string
}>("checkout")
  .when(
    (s) => s.worktree,
    worktreeAdd, (s) => ({ base: s.base, setup: s.worktreeSetup }),
    (tree) => ({ path: tree.path })
  )
  .then(branch, (s) => ({ branch: s.branch, base: s.base }))
  .finalise({
    description: "Materialize the run's worktree when it wants one, then check out the ticket branch.",
    input: Schema.Struct({
      ticket: Schema.String,
      base: Schema.String,
      branch: Schema.String,
      worktree: Schema.Boolean,
      worktreeSetup: Schema.String
    }),
    success: Schema.Struct({ path: Schema.optional(Schema.String) }),
    scope: (input) => ({ ticket: input.ticket, graph: "checkout", worktree: input.worktree }),
    seed: (input) => input,
    out: (s) => (s.path === undefined ? {} : { path: s.path })
  })

/**
 * The rail-sketch's `WriteBody`: `write-pr-body` describes the branch's own merge-base diff into a
 * run-root file, then `compose-pr-body` reads it and writes the body with `Closes #n` and the run id
 * as a second file. The compose step stays `runtime/pr-body.ts`'s helper rather than a node: its
 * only failures are the file read and write, a `PlatformError` every `graph()` union already
 * carries, so `.via`, not a box of its own. It reads the ticket and run id from `RunInfo`, never as
 * a parameter. write-pr-body writes no code, so it carries no agent.
 */
const writeBody = Graph.construct<{ ticket: string; base: string; model: string }>("write-body")
  .thenKeep(
    writePrBody, (s) => ({ base: s.base, model: s.model }),
    (written) => ({ descriptionPath: written.descriptionPath, sessions: written.sessions, costUsd: written.costUsd })
  )
  .via("compose-pr-body", (s) => prBody({ descriptionPath: s.descriptionPath }).pipe(Effect.map((bodyPath) => ({ bodyPath }))))
  .finalise({
    description: "Write the PR description from the merge-base diff, then compose the tracker-closing body.",
    input: Schema.Struct({ ticket: Schema.String, base: Schema.String, model: Schema.String }),
    success: Schema.Struct({
      bodyPath: Schema.String,
      sessions: Schema.Array(Schema.String),
      costUsd: Schema.NullOr(Schema.Number)
    }),
    scope: (input) => ({ ticket: input.ticket, graph: "write-body", worktree: false }),
    seed: (input) => input,
    out: (s) => ({ bodyPath: s.bodyPath, sessions: s.sessions, costUsd: s.costUsd })
  })

/**
 * The rail-sketch's `PublishTail`: `write-body` ∥ `push-branch` — the description reads the local
 * merge-base diff and the push moves refs, so neither waits on the other — joined by `create-pr`,
 * then `worktree-remove` on success only, exactly when `checkout` materialized a path to retire.
 * The PR title is composed here, "{ticket}: {title}", the tail's own concern as drawn.
 */
const publishTail = Graph.construct<{
  ticket: string
  title: string
  base: string
  branch: string
  path?: string
  remote: string
  host: string
  slug: string
  model: string
}>("publish-tail")
  .fork(
    writeBody, (s) => ({ ticket: s.ticket, base: s.base, model: s.model }),
    pushBranch, (s) => ({ remote: s.remote, branch: s.branch, base: s.base })
  )
  .join(createPr, (s) => ({
    host: s.host,
    slug: s.slug,
    base: s.base,
    source: s.branch,
    title: `${s.ticket}: ${s.title}`,
    bodyPath: s.bodyPath
  }))
  .when(
    (s) => s.path !== undefined,
    worktreeRemove, (s) => ({ path: s.path as string }),
    () => ({})
  )
  .finalise({
    description: "Write the body and push in parallel, open the PR, then retire the worktree on success.",
    input: Schema.Struct({
      ticket: Schema.String,
      title: Schema.String,
      base: Schema.String,
      branch: Schema.String,
      path: Schema.optional(Schema.String),
      remote: Schema.String,
      host: Schema.String,
      slug: Schema.String,
      model: Schema.String
    }),
    success: Schema.Struct({
      url: Schema.String,
      sessions: Schema.Array(Schema.String),
      costUsd: Schema.NullOr(Schema.Number)
    }),
    scope: (input) => ({ ticket: input.ticket, graph: "publish-tail", worktree: input.path !== undefined }),
    seed: (input) => input,
    out: (s) => ({ url: s.url, sessions: s.sessions, costUsd: s.costUsd })
  })

/**
 * develop-graph: the north star host, drawn as the rail-sketch draws it — borrow `prepare`, borrow
 * `checkout`, borrow `design-graph`, borrow `build-under-review`, then `prompt-terseness-evaluator`,
 * re-verify when it moved the head, borrow `publish-tail`. Each borrowed graph journals as one row
 * plus its children; the host's scope wins by construction, so the sub-graphs' own `scope`
 * declarations are inert here and honest when run alone. Every per-repo fact `resolvePolicy` would
 * otherwise hardwire is an optional launch input instead — the same run against this repository
 * when every field is absent, a different target when it isn't.
 *
 * Terseness sweeps the whole branch diff — the build's own prompt text included, which is why it
 * sits after the loop rather than between design and build. Its repair commit lands after the
 * loop's green, so a moved head re-runs the declared suite — the same only-when-moved rule
 * `simplify` already follows inside the loop.
 */
export const developGraph = Graph.construct<{ ticket: string } & ReturnType<typeof resolvePolicy>>(
  "develop-graph"
)
  .borrow(prepare, (s) => ({ ticket: s.ticket, base: s.base, remote: s.remote, maintainer: s.maintainer }))
  .borrow(checkout, (s) => ({
    ticket: s.ticket,
    base: s.base,
    branch: s.branch,
    worktree: s.worktree,
    worktreeSetup: s.worktreeSetup
  }))
  .borrowKeep(
    designGraph,
    (s) => ({ ticket: s.ticket, title: s.title, ticketPath: s.ticketPath, agent: s.agent, model: MODEL_DESIGN }),
    (designed) => ({ designPath: designed.designPath, designSessions: designed.sessions, designCost: designed.costUsd })
  )
  .borrowKeep(
    buildUnderReview,
    (s) => ({
      ticket: s.ticket,
      title: s.title,
      ticketPath: s.ticketPath,
      branch: s.branch,
      command: s.verification,
      base: s.base,
      cap: REVIEW_CAP,
      designPath: s.designPath,
      agent: s.agent,
      buildModel: MODEL_BUILD,
      simplifyModel: MODEL_SIMPLIFY,
      reviewModel: MODEL_REVIEW
    }),
    (built) => ({
      summaryPath: built.summaryPath,
      commits: built.commits,
      reviewPasses: built.reviewPasses,
      builtHeadSha: built.headSha,
      buildSessions: built.sessions,
      buildCost: built.costUsd
    })
  )
  .thenKeep(
    promptTersenessEvaluator,
    (s) => ({ ticket: s.ticket, base: s.base, headSha: s.builtHeadSha, agent: s.agent, model: MODEL_DESIGN }),
    (tersened) => ({
      tersenedHeadSha: tersened.headSha,
      terseSessions: tersened.sessions,
      terseCost: tersened.costUsd
    })
  )
  .when(
    (s) => s.tersenedHeadSha !== s.builtHeadSha,
    verification, (s) => ({ command: s.verification, headSha: s.tersenedHeadSha as string }),
    () => ({})
  )
  .borrowKeep(
    publishTail,
    (s) => ({
      ticket: s.ticket,
      title: s.title,
      base: s.base,
      branch: s.branch,
      ...(s.path === undefined ? {} : { path: s.path }),
      remote: s.remote,
      host: s.host,
      slug: s.slug,
      model: MODEL_BUILD
    }),
    (published) => ({ prUrl: published.url, publishSessions: published.sessions, publishCost: published.costUsd })
  )
  .finalise({
    description:
      "Fetch, branch, run design-graph, build under a diff review, run the declared suite — per-repo facts are launch inputs, not constants.",
    input,
    success: Schema.Struct({
      ticket: Schema.String,
      branch: Schema.String,
      summaryPath: Schema.String,
      commits: Schema.Int,
      costUsd: Schema.NullOr(Schema.Number),
      sessions: Schema.Array(Schema.String),
      reviewPasses: Schema.Int,
      prUrl: Schema.String
    }),
    scope: (input) => {
      const { worktree, resume, records } = resolvePolicy(input)
      return { ticket: input.ticket, graph: "develop-graph", worktree, resume, records }
    },
    seed: (input) => ({ ticket: input.ticket, ...resolvePolicy(input) }),
    out: (s) => ({
      ticket: s.ticket,
      branch: s.branch,
      summaryPath: s.summaryPath,
      commits: s.commits,
      // One unpriced session makes the run's own figure unpriced, never silently zero.
      costUsd: [s.designCost, s.terseCost, s.buildCost, s.publishCost].reduce(
        (a, b) => (a === null || b === null ? null : a + b)
      ),
      sessions: [...s.designSessions, ...s.terseSessions, ...s.buildSessions, ...s.publishSessions],
      reviewPasses: s.reviewPasses,
      prUrl: s.prUrl
    })
  })
