import { describe, expect, test } from "bun:test"
import { Result } from "effect"
// Deliberate departure from the house rule that imports use `mag/...` specifiers only:
// package.json's exports map special-cases only `docs/*` for a non-`.ts` text import;
// every other `mag/*` specifier appends `.ts` (`"./*": "./src/*.ts"`), so `mag/graphs/...` 404s
// on this fixture. Confirmed by running it: "Cannot find module 'mag/graphs/design-graph/vision.md'".
import conflictGraphVision from "../graphs/conflict-graph/vision.md" with { type: "text" }
import designGraphVision from "../graphs/design-graph/vision.md" with { type: "text" }
import developGraphVision from "../graphs/develop-graph/vision.md" with { type: "text" }
import { readShape } from "mag/runtime/vision-shape"

describe("readShape", () => {
  test("lifts steps, edges and conditions from the real design-graph fixture", () => {
    const result = readShape("design-graph/vision.md", designGraphVision)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    const { success: shape } = result

    // Steps only: IN/OUT are boundary boxes and must not appear.
    expect(shape.nodes).toContain("detect-svelte")
    expect(shape.nodes).toContain("envision-shell")
    expect(shape.nodes).toContain("assemble-brainstorm-prompt")
    expect(shape.nodes).toContain("brainstorm")
    expect(shape.nodes).not.toContain("IN")
    expect(shape.nodes).not.toContain("OUT")
    // A subgraph title shares the bracket-plus-quote shape but is not a node.
    expect(shape.nodes).not.toContain("probes")

    // A death is an edge endpoint, never a member of `nodes`.
    expect(shape.nodes).not.toContain("BrainstormPromptOversized")
    expect(shape.edges).toContain("assemble-brainstorm-prompt -> BrainstormPromptOversized")

    // A boundary-touching edge is dropped: `IN -- ... --> detect-svelte` never appears.
    expect(shape.edges.some((edge) => edge.startsWith("IN ->"))).toBe(false)
    expect(shape.edges).toContain("envision-shell -> brainstorm")
    expect(shape.edges).toContain("discover -> brainstorm")

    // A conditional edge's clause, cut at the first colon.
    expect(shape.conditions).toContain("assemble-brainstorm-prompt -> BrainstormPromptOversized when bytes > budget")
    expect(shape.conditions).toContain("envision-shell -> ShellBlocked when verdict = blocked")
    // A plain field-mapping edge contributes no condition.
    expect(shape.conditions.some((condition) => condition.startsWith("envision-shell -> brainstorm"))).toBe(false)
  })

  test("design-graph's complete condition list: the shell's two deaths, the recycle-scan death, plus the design-under-review loop's six", () => {
    const result = readShape("design-graph/vision.md", designGraphVision)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    const loop = result.success.conditions.filter((condition) =>
      condition.startsWith("envision-shell ->") || condition.startsWith("brainstorm ->") || condition.startsWith("review-plan ->") || condition.startsWith("recycle-scan ->")
    )
    expect(loop).toEqual([
      "envision-shell -> ShellBlocked when verdict = blocked",
      "envision-shell -> ShellMissing when design missing, blank or unchanged",
      "recycle-scan -> RecycleScanDesignUnreadable | RecycleScanFileUnreadable | RecycleScanWriteFailed when design unreadable, a tracked file unreadable, or the table unwritable",
      "review-plan -> brainstorm when verdict = blocked, a finding targets design, design sendbacks < cap",
      "review-plan -> plan when verdict = blocked, every finding targets plan, plan sendbacks < cap",
      "brainstorm -> review-plan when verdict = disputed",
      "brainstorm -> DesignMissing | PlanMissing | PlanBlocked (cap spent) | PlanDisputeRejected when design missing or unchanged and silent",
      "review-plan -> DesignMissing | PlanMissing | PlanBlocked (cap spent) | PlanDisputeRejected when verdict = blocked, cap exhausted",
      "review-plan -> DesignMissing | PlanMissing | PlanBlocked (cap spent) | PlanDisputeRejected when adjudicating pass rejects a disputed finding"
    ])
  })

  test("a subgraph title carrying the box's own bracket-plus-quote shape is excluded by the line filter", () => {
    const text = '```mermaid\ngraph TD\n  subgraph Probes["probes"]\n  A["load · Mechanical<br/>job"]\n  end\n```'
    const result = readShape("fixture", text)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.nodes).toEqual(["load"])
  })

  test("an edge touching a boundary box is dropped rather than guessed at", () => {
    const text =
      '```mermaid\ngraph TD\n  IN[["thing(id)"]]\n  A["load · Mechanical<br/>job"]\n  IN -- "id → id" --> A\n```'
    const result = readShape("fixture", text)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.edges).toEqual([])
  })

  test("a plain mapping carries no condition, only the edge", () => {
    const text =
      '```mermaid\ngraph TD\n  A["load · Mechanical<br/>job"]\n  B["save · Mechanical<br/>job"]\n  A -- "record → record" --> B\n```'
    const result = readShape("fixture", text)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.edges).toEqual(["load -> save"])
    expect(result.success.conditions).toEqual([])
  })

  // The grammar, one label at a time (the colon rule once read gate annotations and death lists
  // as clauses and missed a colon-less firing clause).
  const conditionOf = (label: string) => {
    const text = `\`\`\`mermaid\ngraph TD\n  A["load · Mechanical<br/>job"]\n  B["save · Mechanical<br/>job"]\n  A -- "${label}" --> B\n\`\`\``
    const result = readShape("fixture", text)
    if (!Result.isSuccess(result)) throw new Error("fixture unreadable")
    return result.success.conditions
  }

  test("a firing clause before a colon-less mapping is a condition (the notation doc's own form)", () => {
    expect(conditionOf("verdict = passed → (gate)")).toEqual(["load -> save when verdict = passed"])
  })

  test("a bare firing clause with no mapping at all is a condition (a death edge's label)", () => {
    expect(conditionOf("verdict = rejected")).toEqual(["load -> save when verdict = rejected"])
  })

  test("a mapping onto a gate annotation is not a condition, even though its label carries a colon", () => {
    expect(conditionOf("path → (gate: run continues inside the worktree)")).toEqual([])
    expect(conditionOf("(gate: pushed) → pushed")).toEqual([])
    expect(conditionOf("(gate) → (resolved = true)")).toEqual([])
  })

  test("a death's error list is not a condition", () => {
    expect(conditionOf("fails: PushDirty | PushEmpty | PushRejected")).toEqual([])
    expect(conditionOf("fails (not disputed): BuildNoCommits | BuildHeadMoved")).toEqual([])
  })

  test("a mapping's left side is not a clause, whatever it contains", () => {
    expect(conditionOf("base? → base")).toEqual([])
    expect(conditionOf("headSha, sessions, costUsd → headSha, sessions, costUsd")).toEqual([])
    expect(conditionOf("ticket → (R channel: ticket, runId)")).toEqual([])
  })

  test("develop-graph's complete condition list: nine, none of them a truncated gate mapping", () => {
    const result = readShape("develop-graph/vision.md", developGraphVision)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.conditions).toEqual([
      "resolve-base -> worktree-add when worktree = true (default)",
      "resolve-base -> branch when worktree = false",
      "verification -> build when red",
      "build -> review-diff when verdict = disputed",
      "review-diff -> build when verdict = blocked, sendbacks < cap",
      "review-diff -> checkout-through-publish error, uncaught when verdict = blocked, cap exhausted",
      "review-diff -> checkout-through-publish error, uncaught when adjudicating pass rejected",
      "review-diff -> prompt-terseness-evaluator when verdict = clean",
      "create-pr -> worktree-remove when worktree = true"
    ])
  })

  test("conflict-graph's complete condition list: seven, `verdict = passed → (gate)` among them", () => {
    const result = readShape("conflict-graph/vision.md", conflictGraphVision)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.conditions).toEqual([
      "detect-conflicts -> worktree-add when verdict = conflicted",
      "stage-check -> verify when clean stage",
      "stage-check -> resolve when unresolved paths or markers left, attempts < cap",
      "verify -> resolve when verdict = failed, attempts < cap",
      "stage-check -> open-through-finish error, uncaught when unresolved paths or markers left, attempts = cap",
      "verify -> open-through-finish error, uncaught when verdict = failed, attempts = cap",
      "verify -> commit-merge when verdict = passed"
    ])
  })

  test("a document with no fenced mermaid is unreadable", () => {
    const result = readShape("fixture", "# Just prose, no diagram.")
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure._tag).toBe("VISION_UNREADABLE")
    expect(result.failure.path).toBe("fixture")
  })

  test("a fenced mermaid block with no boxes is unreadable", () => {
    const result = readShape("fixture", "```mermaid\ngraph TD\n```")
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure._tag).toBe("VISION_UNREADABLE")
  })
})
