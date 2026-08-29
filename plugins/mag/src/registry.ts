import { analyseReviews } from "mag/graph-nodes/analyse-reviews/graph-node"
import { assembleBrainstormPrompt } from "mag/graph-nodes/assemble-brainstorm-prompt/graph-node"
import { branch } from "mag/graph-nodes/branch/graph-node"
import { build } from "mag/graph-nodes/build/graph-node"
import { buildUnderReview } from "mag/graph-nodes/build-under-review/graph-node"
import { commentTicket } from "mag/graph-nodes/comment-ticket/graph-node"
import { compareVision } from "mag/graph-nodes/compare-vision/graph-node"
import { compileSkill } from "mag/graph-nodes/compile-skill/graph-node"
import { conformance } from "mag/graph-nodes/conformance/graph-node"
import { create } from "mag/graph-nodes/create/graph-node"
import { createGraphFolder } from "mag/graph-nodes/create-graph-folder/graph-node"
import { createPr } from "mag/graph-nodes/create-pr/graph-node"
import { deriveVision } from "mag/graph-nodes/derive-vision/graph-node"
import { design } from "mag/graph-nodes/design/graph-node"
import { detectConflicts } from "mag/graph-nodes/detect-conflicts/graph-node"
import { detectEffect } from "mag/graph-nodes/detect-effect/graph-node"
import { detectGraphCore } from "mag/graph-nodes/detect-graph-core/graph-node"
import { detectSvelte } from "mag/graph-nodes/detect-svelte/graph-node"
import { discover } from "mag/graph-nodes/discover/graph-node"
import { envisionMermaid } from "mag/graph-nodes/envision-mermaid/graph-node"
import { envisionNotation } from "mag/graph-nodes/envision-notation/graph-node"
import { envisionRailSketch } from "mag/graph-nodes/envision-rail-sketch/graph-node"
import { fetchTicket } from "mag/graph-nodes/fetch-ticket/graph-node"
import { fixConflicts } from "mag/graph-nodes/fix-conflicts/graph-node"
import { gatherReviews } from "mag/graph-nodes/gather-reviews/graph-node"
import { githubTicketCreate } from "mag/graph-nodes/github-ticket-create/graph-node"
import { plan } from "mag/graph-nodes/plan/graph-node"
import { promptTersenessEvaluator } from "mag/graph-nodes/prompt-terseness-evaluator/graph-node"
import { publish } from "mag/graph-nodes/publish/graph-node"
import { pushBranch } from "mag/graph-nodes/push-branch/graph-node"
import { recycleScan } from "mag/graph-nodes/recycle-scan/graph-node"
import { requireAcs } from "mag/graph-nodes/require-acs/graph-node"
import { resolveBase } from "mag/graph-nodes/resolve-base/graph-node"
import { resolveConflicts } from "mag/graph-nodes/resolve-conflicts/graph-node"
import { resumeRun } from "mag/graph-nodes/resume-run/graph-node"
import { reviewDiff } from "mag/graph-nodes/review-diff/graph-node"
import { reviewPlan } from "mag/graph-nodes/review-plan/graph-node"
import { simplify } from "mag/graph-nodes/simplify/graph-node"
import { stageShippedGraph } from "mag/graph-nodes/stage-shipped-graph/graph-node"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { worktreeAdd } from "mag/graph-nodes/worktree-add/graph-node"
import { worktreeRemove } from "mag/graph-nodes/worktree-remove/graph-node"
import { writePrBody } from "mag/graph-nodes/write-pr-body/graph-node"
import { writeTicket } from "mag/graph-nodes/write-ticket/graph-node"
import { branchName } from "mag/graphs/branch-name/graph"
import { codeToVisionReview } from "mag/graphs/code-to-vision-review/graph"
import { conflictGraph } from "mag/graphs/conflict-graph/graph"
import { designGraph } from "mag/graphs/design-graph/graph"
import { developGraph } from "mag/graphs/develop-graph/graph"
import { envision } from "mag/graphs/envision/graph"
import { reviewPatternGraph } from "mag/graphs/review-pattern-graph/graph"
import { ticketWriter } from "mag/graphs/ticket-writer/graph"
import { psCommand } from "mag/ps"
import type { Registry } from "mag/runtime/types"
import { topologyCommand } from "mag/topology"

// The command tree is data, not code.
export const registry: Registry = [
  {
    kind: "group",
    group: "node",
    description: "Commands that operate on GraphNode directories.",
    children: [{ kind: "command", node: conformance }, { kind: "command", node: create }]
  },
  { kind: "command", node: createGraphFolder },
  { kind: "command", node: envisionMermaid },
  { kind: "command", node: envisionRailSketch },
  { kind: "command", node: envision },
  { kind: "command", node: fetchTicket },
  { kind: "command", node: requireAcs },
  { kind: "command", node: resolveBase },
  { kind: "command", node: worktreeAdd },
  { kind: "command", node: worktreeRemove },
  { kind: "command", node: branch },
  { kind: "command", node: design },
  { kind: "command", node: discover },
  { kind: "command", node: recycleScan },
  { kind: "command", node: promptTersenessEvaluator },
  { kind: "command", node: assembleBrainstormPrompt },
  { kind: "command", node: envisionNotation },
  { kind: "command", node: plan },
  { kind: "command", node: reviewPlan },
  { kind: "command", node: designGraph },
  { kind: "command", node: build },
  { kind: "command", node: verification },
  { kind: "command", node: simplify },
  { kind: "command", node: reviewDiff },
  { kind: "command", node: buildUnderReview },
  { kind: "command", node: writePrBody },
  { kind: "command", node: pushBranch },
  { kind: "command", node: createPr },
  { kind: "command", node: publish },
  { kind: "command", node: detectConflicts },
  { kind: "command", node: detectSvelte },
  { kind: "command", node: detectEffect },
  { kind: "command", node: detectGraphCore },
  { kind: "command", node: fixConflicts },
  { kind: "command", node: resolveConflicts },
  { kind: "command", node: branchName },
  { kind: "command", node: developGraph },
  { kind: "command", node: conflictGraph },
  { kind: "command", node: gatherReviews },
  { kind: "command", node: analyseReviews },
  { kind: "command", node: resumeRun },
  { kind: "command", node: commentTicket },
  { kind: "command", node: reviewPatternGraph },
  // Both children register on their own beside their graph, design-graph's own precedent.
  { kind: "command", node: writeTicket },
  { kind: "command", node: githubTicketCreate },
  { kind: "command", node: ticketWriter },
  // The three-node review pipeline plus the graph that composes them.
  { kind: "command", node: stageShippedGraph },
  { kind: "command", node: deriveVision },
  { kind: "command", node: compareVision },
  { kind: "command", node: codeToVisionReview },
  // A repo-level command with no per-ticket run scope, same shape as `conformance`/`node
  // create` — not under the `node` group, whose description is scoped to GraphNode directories.
  { kind: "command", node: compileSkill },
  // Not a GraphNode (`ps.ts`'s module comment) — a "raw" entry, not "command".
  { kind: "raw", command: psCommand },
  // A diagram for a human, not a GraphNode — same "raw" reasoning as `ps` (`topology.ts`'s module comment).
  { kind: "raw", command: topologyCommand }
]

/**
 * `format-branch-name`, `resolve-notations`, `envision-visions`, `brainstorm` and
 * `design-under-review` are deliberately absent. Their `labels`/`verdicts`/`notations`/`visionPaths`
 * fields are arrays, and
 * `schema-flags.ts` derives flags for `string`/`number`/`boolean` only — registering any of them
 * would fail the whole CLI build with `UNSUPPORTED_INPUT_SCHEMA`, not just its own subcommand,
 * because `build-cli.ts` folds the registry with `Result.all`. Shaping the field as a comma-joined
 * string purely to make it CLI-representable would bend the node's contract to suit a tool, and the
 * node's input schema is its whole contract. They run through `design-graph` and through their own
 * tests instead. `assemble-brainstorm-prompt` has no such field and registers above.
 */
