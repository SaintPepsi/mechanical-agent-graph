import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Data, Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import {
  applyModifiers,
  type Blueprint,
  DecisionNameCollides,
  FieldHasNoProducer,
  Graph,
  type Modifier,
  ModifierConflict,
  ModifierTargetAmbiguous,
  ModifierTargetMissing,
  projectSteps,
  type Step,
  TooConvoluted
} from "mag/runtime/construct"
import { graph } from "mag/runtime/graph"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { make } from "mag/runtime/graph-node.definition"
import type { GraphShape } from "mag/runtime/graph-shape"
import {
  type RepoRootUnavailable,
  type RepositoryIdentityUnavailable,
  type RootEnv,
  RunRootEnv,
  type UnsafePathSegment
} from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { RunId } from "mag/runtime/trace/layer"
import { type CommandNotExecutable, type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

/**
 * `Graph.construct` is notation over `graph()`, so what it must prove is exactly what
 * `graph-composition.test.ts` proves for `graph()` — one journal, the host's scope — plus its own
 * stage semantics: a fork runs both sides and merges both successes, `keep` renames a merge, a
 * failed `when` condition skips the node and lets the context flow on, `.via` merges a plain
 * Effect's result, and a finalised construct borrows into another construct as one node.
 *
 * It also proves the borrow/modify lifecycle. `removeWhen`/`replaceNode` are declared at the
 * borrowing site and must never edit the borrowed construct's own definition — proved by running
 * the same borrowed construct twice, bent and unbent, and reading both off the journal.
 */

const left = make({
  name: "fixture-left",
  description: "One side of the fork; success echoes the seed through the wire.",
  input: Schema.Struct({ seedVal: Schema.String }),
  success: Schema.Struct({ a: Schema.String }),
  run: (input) => Effect.succeed({ a: `a:${input.seedVal}` })
})

const right = make({
  name: "fixture-right",
  description: "The other side of the fork.",
  input: Schema.Struct({}),
  success: Schema.Struct({ b: Schema.String }),
  run: () => Effect.succeed({ b: "b" })
})

const joiner = make({
  name: "fixture-join",
  description: "Sees both fork successes off the context.",
  input: Schema.Struct({ a: Schema.String, b: Schema.String }),
  success: Schema.Struct({ joined: Schema.String }),
  run: (input) => Effect.succeed({ joined: `${input.a}+${input.b}` })
})

const guarded = make({
  name: "fixture-guarded",
  description: "The `when` node: its journal row is the evidence of whether it was entered.",
  input: Schema.Struct({}),
  success: Schema.Struct({ ran: Schema.Boolean }),
  run: () => Effect.succeed({ ran: true })
})

const notify = make({
  name: "fixture-notify",
  description: "The swappable node: the default, loud behavior.",
  input: Schema.Struct({}),
  success: Schema.Struct({ notified: Schema.String }),
  run: () => Effect.succeed({ notified: "loud" })
})

const quietNotify = make({
  name: "fixture-quiet-notify",
  description: "Same contract as `notify`, quieter behavior — the `.replaceNode` replacement.",
  input: Schema.Struct({}),
  success: Schema.Struct({ notified: Schema.String }),
  run: () => Effect.succeed({ notified: "quiet" })
})

const unenumerable = make({
  name: "fixture-unenumerable",
  description: "Its success is a union, so no field list can be read off it — the opaque case.",
  input: Schema.Struct({}),
  success: Schema.Union([Schema.Struct({ x: Schema.String }), Schema.Struct({ y: Schema.String })]),
  run: () => Effect.succeed({ x: "x" })
})

const indexSigned = make({
  name: "fixture-index-signed",
  description: "Its success carries an index signature, so its named fields are not an exhaustive list — also opaque.",
  input: Schema.Struct({}),
  success: Schema.Record(Schema.String, Schema.String),
  run: () => Effect.succeed({ x: "x" })
})

class FixtureNotifyError extends Data.TaggedError("FIXTURE_NOTIFY_ERROR")<{ readonly reason: string }> {}

const widerErrorNotify = make({
  name: "fixture-wider-error-notify",
  description: "Same input/success as `notify`, but can fail — an illegal `replaceNode` replacement (widens `E`).",
  input: Schema.Struct({}),
  success: Schema.Struct({ notified: Schema.String }),
  run: () => Effect.fail(new FixtureNotifyError({ reason: "unreachable in these tests" }))
})

const differentSuccessNotify = make({
  name: "fixture-different-success-notify",
  description: "`notified` typed as a number, not `notify`'s string — an illegal `replaceNode` replacement.",
  input: Schema.Struct({}),
  success: Schema.Struct({ notified: Schema.Number }),
  run: () => Effect.succeed({ notified: 1 })
})

/** Every borrow/modify fixture below finalises the same shape (the bendable sub's schemas, its
 *  flag seed, its success projection) and differs only in name, scope and prose. Shared so each
 *  construct below reads as the bend it declares rather than as another copy of the schemas. */
const bendableSuccess = Schema.Struct({ guardedRan: Schema.optional(Schema.Boolean), notified: Schema.String })
const bendableFinalise = (graph: string, ticket: string, description: string) => ({
  description,
  input: Schema.Struct({ flag: Schema.Boolean }),
  success: bendableSuccess,
  scope: () => ({ ticket, graph, worktree: false }),
  seed: (input: { readonly flag: boolean }) => input,
  out: (ctx: {
    readonly guardedRan?: boolean | undefined
    readonly notified: string
  }): Schema.Schema.Type<typeof bendableSuccess> => ({
    notified: ctx.notified,
    ...(ctx.guardedRan === undefined ? {} : { guardedRan: ctx.guardedRan })
  })
})

const bendableSub = Graph.construct<{ flag: boolean }>("fixture-bendable")
  .when(
    { name: "flag is set", reads: ["flag"], test: (s) => s.flag },
    guarded, () => ({}),
    { guardedRan: (g) => g.ran }
  )
  .then(notify, () => ({}))
  .finalise(bendableFinalise(
    "fixture-bendable",
    "GH-290-bendable",
    "A when-guarded node and a swappable node — the borrow/modify tests below bend this from the borrowing site, never edit it."
  ))

const bentHost = Graph.construct<{ flag: boolean }>("fixture-bent-host")
  .borrow(bendableSub, (s) => ({ flag: s.flag }))
    .removeWhen(guarded)
    .replaceNode(notify, quietNotify)
  .finalise(bendableFinalise(
    "fixture-bent-host",
    "GH-290-bent",
    "Bends the borrowed construct at this borrowing site: strips its guard, swaps its notify node."
  ))

const plainHost = Graph.construct<{ flag: boolean }>("fixture-plain-host")
  .borrow(bendableSub, (s) => ({ flag: s.flag }))
  .finalise(bendableFinalise(
    "fixture-plain-host",
    "GH-290-plain",
    "Borrows the same construct with no bends — the regression half of 'no file edited'."
  ))

/** Four same-contract, independently-swappable nodes at one borrowing site, enough targets to
 *  prove 3 applications build and a 4th refuses, without two modifiers ever naming one target
 *  (`ModifierConflict`). */
const convolutionNode = (slot: number, variant: "target" | "replacement") =>
  make({
    name: `fixture-convolution-${variant}-${slot}`,
    description: `The convolution fixture: slot ${slot}'s ${variant}.`,
    input: Schema.Struct({}),
    success: Schema.Struct({ notified: Schema.String }),
    run: () => Effect.succeed({ notified: `${variant}-${slot}` })
  })

const convolutionTarget1 = convolutionNode(1, "target")
const convolutionTarget2 = convolutionNode(2, "target")
const convolutionTarget3 = convolutionNode(3, "target")
const convolutionTarget4 = convolutionNode(4, "target")
const convolutionReplacement1 = convolutionNode(1, "replacement")
const convolutionReplacement2 = convolutionNode(2, "replacement")
const convolutionReplacement3 = convolutionNode(3, "replacement")
const convolutionReplacement4 = convolutionNode(4, "replacement")

/** The convolution fixtures share one finalise shape (empty input, one `notified` success field);
 *  only the graph name and scope vary per test construct. */
const convolutionFinalise = (graphName: string, ticket: string) => ({
  description: `Convolution fixture host: ${graphName}.`,
  input: Schema.Struct({}),
  success: Schema.Struct({ notified: Schema.String }),
  scope: () => ({ ticket, graph: graphName, worktree: false }),
  seed: (input: object) => input,
  out: (ctx: { readonly notified: string }) => ({ notified: ctx.notified })
})

const convolutionSub = Graph.construct<{}>("fixture-convolution-sub")
  .then(convolutionTarget1, () => ({}))
  .then(convolutionTarget2, () => ({}))
  .then(convolutionTarget3, () => ({}))
  .then(convolutionTarget4, () => ({}))
  .finalise(convolutionFinalise("fixture-convolution-sub", "GH-291-sub"))

const convolutionThreeHost = Graph.construct<{}>("fixture-convolution-three-host")
  .borrow(convolutionSub, () => ({}))
    .replaceNode(convolutionTarget1, convolutionReplacement1)
    .replaceNode(convolutionTarget2, convolutionReplacement2)
    .replaceNode(convolutionTarget3, convolutionReplacement3)
  .finalise(convolutionFinalise("fixture-convolution-three-host", "GH-291-three"))

const sub = Graph.construct<{ ticket: string; flag: boolean; seedVal: string }>("fixture-construct")
  .fork(
    left, (s) => ({ seedVal: s.seedVal }),
    right, () => ({})
  )
  .join(joiner, (s) => ({ a: s.a, b: s.b }))
  .when(
    { name: "flag is set", reads: ["flag"], test: (s) => s.flag },
    guarded, () => ({}),
    { guardedRan: (g) => g.ran }
  )
  .via("uppercase", (s) => Effect.succeed(s.joined.toUpperCase()), { upper: (upper) => upper })
  .finalise({
    description: "Fork, join, a guarded node, a plain-Effect stage.",
    input: Schema.Struct({ ticket: Schema.String, flag: Schema.Boolean, seedVal: Schema.String }),
    success: Schema.Struct({
      joined: Schema.String,
      upper: Schema.String,
      guardedRan: Schema.optional(Schema.Boolean)
    }),
    scope: (input) => ({ ticket: input.ticket, graph: "fixture-construct", worktree: false }),
    seed: (input) => input,
    out: (s) => ({
      joined: s.joined,
      upper: s.upper,
      ...(s.guardedRan === undefined ? {} : { guardedRan: s.guardedRan })
    })
  })

const host = Graph.construct<{ ticket: string; flag: boolean; seedVal: string }>("fixture-construct-host")
  .borrow(sub, (s) => ({ ticket: s.ticket, flag: s.flag, seedVal: s.seedVal }))
  .finalise({
    description: "Borrows the finalised construct as one node among its own.",
    input: Schema.Struct({ ticket: Schema.String, flag: Schema.Boolean, seedVal: Schema.String }),
    success: Schema.Struct({ joined: Schema.String, upper: Schema.String }),
    scope: (input) => ({ ticket: input.ticket, graph: "fixture-construct-host", worktree: false }),
    seed: (input) => input,
    out: (s) => ({ joined: s.joined, upper: s.upper })
  })

const RUN_ID = "20260823090000-c0de"
const REPO_ROOT = "/repo/fixture"

const gitShell = (): ShellService => ({
  run: (argv): Effect.Effect<ShellResult> => {
    // run-layers.ts's identity check — same answer on both sides keeps every run here a home run.
    if (argv.includes("--git-common-dir")) return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}/.git\n`, stderr: "" })
    if (argv.includes("--show-toplevel")) return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}\n`, stderr: "" })
    if (argv.includes("HEAD")) return Effect.succeed({ exitCode: 0, stdout: "abc123\n", stderr: "" })
    throw new Error(`gitShell: unexpected argv ${argv.join(" ")}`)
  }
})

const tempRoot = (): RootEnv => ({
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "construct-")) },
  home: "/unused"
})

/** Runs a finalised node against a fresh journal root and reads its rows back. `ticket` is the one
 *  the node's own `scope` mints, since that is what names the journal file. */
const runNode = async <I, A, E, R>(node: GraphNode<I, A, E, R>, input: I, ticket: string) => {
  const root = tempRoot()
  const success = await Effect.runPromise(
    node.run(input).pipe(
      Effect.provideService(RunRootEnv, root),
      Effect.provideService(RunId, RUN_ID),
      Effect.provide(shellLayer(gitShell()))
    ) as Effect.Effect<A>
  )
  const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket, runId: RUN_ID })
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly node: string; readonly runId: string; readonly graph: string })
  return { success, rows }
}

const runHost = (ticket: string, flag: boolean) => runNode(host, { ticket, flag, seedVal: "seed" }, ticket)

/** Runs `f`, asserts it threw `Class`, and hands the error back typed: the assertions below are about
 *  the payload (`offered`, `matched`), which `expect(...).toThrow(Class)` proves the tag of but strands. */
const thrown = <T>(Class: new (...args: never[]) => T, f: () => unknown): T => {
  try {
    f()
  } catch (error) {
    expect(error).toBeInstanceOf(Class)
    return error as T
  }
  throw new Error(`expected ${Class.name}`)
}

describe("Graph.construct", () => {
  test("fork runs both sides, join sees both successes, via merges, and the borrow journals as one run", async () => {
    const { success, rows } = await runHost("GH-289-fork", true)

    expect(success).toEqual({ joined: "a:seed+b", upper: "A:SEED+B" })

    const names = rows.map((row) => row.node)
    expect(names).toContain("fixture-left")
    expect(names).toContain("fixture-right")
    expect(names).toContain("fixture-join")
    expect(names).toContain("fixture-guarded") // flag: true — the `when` entered
    expect(names).toContain("fixture-construct") // the borrowed construct, one row of its own

    // One run, the host's: a finalised construct is a graph(), so composition mints no second scope.
    expect(rows.every((row) => row.runId === RUN_ID)).toBe(true)
    expect(rows.every((row) => row.graph === "fixture-construct-host")).toBe(true)
  })

  test("disconfirming: a failed when condition skips the node and the context flows on", async () => {
    const { success, rows } = await runHost("GH-289-when", false)

    expect(success).toEqual({ joined: "a:seed+b", upper: "A:SEED+B" })
    expect(rows.map((row) => row.node)).not.toContain("fixture-guarded")
  })
})

// Compile-time pin on `.finalise`'s declared error union. Typing `.finalise` as `GraphNode<SI, SA,
// E, R>` would silently drop the run-layer tags `graph()` adds; nothing at runtime can observe
// `E`, so the pin has to live in the type system. A `bun run typecheck` failure here is the whole
// test: the `describe` below only keeps it visible. `RepositoryIdentityUnavailable` is one of the
// tags `runScopedLayers` (`run-layers.ts`) adds to the union, and the pin has to move whenever that
// set changes.
type ErrorOf<N> = N extends GraphNode<any, any, infer E, any> ? E : never
type Extends<A, B> = [A] extends [B] ? true : false
type FinalisedError = ErrorOf<typeof plainHost>
const _runLayerTagsSurvive: Extends<
  UnsafePathSegment | RepoRootUnavailable | RepositoryIdentityUnavailable | CommandNotExecutable | PlatformError,
  FinalisedError
> = true
const _notErasedToNever: Extends<FinalisedError, never> = false

describe("Graph.construct — .finalise keeps graph()'s error union", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_runLayerTagsSurvive).toBe(true)
    expect(_notErasedToNever).toBe(false)
  })
})

// Compile-time pin on `Blueprint`: `applied` is the tally a borrower inherits, and it must stay
// required. A `Blueprint` missing it does not extend `Blueprint`, so making the field optional
// (silently reopening a borrow-laundering route) fails `tsc`, since the omitted shape would then
// satisfy `Blueprint` and flip this to `true`.
type _BlueprintWithoutApplied = Omit<Blueprint, "applied">
const _appliedStaysRequired: Extends<_BlueprintWithoutApplied, Blueprint> = false

describe("Graph.construct — Blueprint.applied stays required", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_appliedStaysRequired).toBe(false)
  })
})

describe("Graph.construct — a keep is a field-picker map, not a bare function", () => {
  test("compile time: thenKeep rejects a bare function keep, and .via requires its third argument", () => {
    const pins = Graph.construct<{ x: string }>("fixture-keep-pins")

    // The positive control: a picker-map keep compiles.
    pins.thenKeep(notify, () => ({}), { tag: (a) => a.notified })

    // @ts-expect-error — a bare function was `Keep`'s shape before this ticket; PRINCIPLES.md's
    // compile-time-pin ruling exists so this erosion cannot ship invisibly.
    pins.thenKeep(notify, () => ({}), (a) => ({ tag: a.notified }))
    // @ts-expect-error — `.via` now declares the fields it contributes as a third argument
    pins.via("stage", (s) => Effect.succeed(s.x))

    expect(true).toBe(true)
  })
})

describe("Graph.construct — borrow/modify lifecycle", () => {
  test("removeWhen strips the borrowed when condition — the guarded node runs unconditionally", async () => {
    const { success, rows } = await runNode(bentHost, { flag: false }, "GH-290-bent")

    expect(success.guardedRan).toBe(true)
    expect(rows.map((row) => row.node)).toContain("fixture-guarded")
  })

  test("replaceNode swaps the borrowed node — the replacement's row appears, not the original's", async () => {
    const { success, rows } = await runNode(bentHost, { flag: false }, "GH-290-bent")

    expect(success.notified).toBe("quiet")
    const names = rows.map((row) => row.node)
    expect(names).toContain("fixture-quiet-notify")
    expect(names).not.toContain("fixture-notify")
  })

  test("no file inside the subgraph is edited: the unbent borrow still skips the guard and runs the original node", async () => {
    const { success, rows } = await runNode(plainHost, { flag: false }, "GH-290-plain")

    expect(success.notified).toBe("loud")
    const names = rows.map((row) => row.node)
    expect(names).not.toContain("fixture-guarded")
    expect(names).toContain("fixture-notify")
  })

  test("disconfirming: a modifier targeting nothing throws a named error at Finalise, never a silent no-op", () => {
    const rogue = make({
      name: "fixture-rogue",
      description: "A node the bendable sub never runs — the modifier's target does not exist.",
      input: Schema.Struct({}),
      success: Schema.Struct({ ran: Schema.Boolean }),
      run: () => Effect.succeed({ ran: true })
    })

    // Declared inside the test body: a top-level throw at module evaluation would take the whole
    // suite down with it, since `.finalise` runs at declaration time.
    const error = thrown(ModifierTargetMissing, () =>
      Graph.construct<{ flag: boolean }>("fixture-doomed-host")
        .borrow(bendableSub, (s) => ({ flag: s.flag }))
        .removeWhen(rogue)
        .finalise(bendableFinalise(
          "fixture-doomed-host",
          "GH-290-doomed",
          "Targets a node the borrowed graph never runs."
        )))

    // offered is what keeps this non-silent: naming the real candidates, not just failing.
    // removeWhen's candidates are guarded nodes only — bendableSub guards exactly `fixture-guarded`.
    expect(error.offered).toEqual(["fixture-guarded"])
  })

  test("compile time: replaceNode rejects a replacement outside the target's contract", () => {
    const attempt = Graph.construct<{ flag: boolean }>("fixture-mismatch-host")
      .borrow(bendableSub, (s) => ({ flag: s.flag }))

    // @ts-expect-error — raises FIXTURE_NOTIFY_ERROR, a tag `notify` never could (closed error unions stay closed)
    attempt.replaceNode(notify, widerErrorNotify)
    // @ts-expect-error — succeeds with `notified: number`, not `notify`'s `notified: string`
    attempt.replaceNode(notify, differentSuccessNotify)

    expect(true).toBe(true)
  })

  test("compile time: a decision without a name or a field list does not compile", () => {
    const pins = Graph.construct<{ flag: boolean; other: string }>("fixture-decision-pins")

    // The positive control: a decision that names itself and declares what it reads compiles.
    pins.when({ name: "flag is set", reads: ["flag"], test: (s) => s.flag }, guarded, () => ({}), {})

    // @ts-expect-error — no name: a decision the shape cannot address
    pins.when({ reads: ["flag"], test: (s) => s.flag }, guarded, () => ({}), {})
    // @ts-expect-error — no read list: nothing for a data edge to start from
    pins.when({ name: "flag is set", test: () => true }, guarded, () => ({}), {})
    // @ts-expect-error — an empty read list fails the non-empty tuple
    pins.when({ name: "flag is set", reads: [], test: () => true }, guarded, () => ({}), {})
    // @ts-expect-error — `missing` is not a field of this construct's context
    pins.when({ name: "flag is set", reads: ["missing"], test: () => true }, guarded, () => ({}), {})
    // @ts-expect-error — the test reads `other`, which this decision did not declare
    pins.when({ name: "flag is set", reads: ["flag"], test: (s) => s.other.length > 0 }, guarded, () => ({}), {})

    expect(true).toBe(true)
  })
})

describe("Graph.construct — convolution guard", () => {
  test("a fourth application at one borrowing site refuses Finalise with the guard's message", () => {
    const error = thrown(TooConvoluted, () =>
      Graph.construct<{}>("fixture-convolution-four-host")
        .borrow(convolutionSub, () => ({}))
          .replaceNode(convolutionTarget1, convolutionReplacement1)
          .replaceNode(convolutionTarget2, convolutionReplacement2)
          .replaceNode(convolutionTarget3, convolutionReplacement3)
          .replaceNode(convolutionTarget4, convolutionReplacement4)
        .finalise(convolutionFinalise("fixture-convolution-four-host", "GH-291-four")))

    expect(error.applications).toBe(4)
    expect(error.limit).toBe(3)
    expect(error.site).toBe("node[0]")
    expect(error.message).toContain("envision a new graph instead")
  })

  test("nested borrows accumulate — 2 applications at an inner site plus 2 more at the outer refuse at 4", () => {
    // midHost's own two extra `.then` steps give the outer real, resolvable targets to bend:
    // nesting isn't transparent, so `convolutionSub`'s own target3/target4 slots, already folded
    // into the borrow midHost resolves, are unreachable from outside midHost — nesting is not
    // transparent. Real targets prove the outer would otherwise build clean, not merely
    // fail a different way, if the guard were removed.
    const midHost = Graph.construct<{}>("fixture-convolution-mid-host")
      .borrow(convolutionSub, () => ({}))
        .replaceNode(convolutionTarget1, convolutionReplacement1)
        .replaceNode(convolutionTarget2, convolutionReplacement2)
      .then(convolutionTarget3, () => ({}))
      .then(convolutionTarget4, () => ({}))
      .finalise(convolutionFinalise("fixture-convolution-mid-host", "GH-291-mid"))

    const error = thrown(TooConvoluted, () =>
      Graph.construct<{}>("fixture-convolution-nested-host")
        .borrow(midHost, () => ({}))
          .replaceNode(convolutionTarget3, convolutionReplacement3)
          .replaceNode(convolutionTarget4, convolutionReplacement4)
        .finalise(convolutionFinalise("fixture-convolution-nested-host", "GH-291-nested")))

    expect(error.applications).toBe(4)
    expect(error.limit).toBe(3)
  })

  test("disconfirming: exactly 3 applications at one site builds and runs; the guard never fires early", async () => {
    const { success, rows } = await runNode(convolutionThreeHost, {}, "GH-291-three")

    expect(success.notified).toBe("target-4") // the untouched fourth slot, last to run
    const names = rows.map((row) => row.node)
    expect(names).toContain("fixture-convolution-replacement-1")
    expect(names).toContain("fixture-convolution-replacement-2")
    expect(names).toContain("fixture-convolution-replacement-3")
    expect(names).not.toContain("fixture-convolution-target-1")
    expect(names).not.toContain("fixture-convolution-target-2")
    expect(names).not.toContain("fixture-convolution-target-3")
    expect(names).toContain("fixture-convolution-target-4")
  })

  test("counts do not pool, disconfirming: two independent sites at 2 applications each both build", () => {
    const twoSites = Graph.construct<{}>("fixture-convolution-two-sites")
      .borrow(convolutionSub, () => ({}))
        .replaceNode(convolutionTarget1, convolutionReplacement1)
        .replaceNode(convolutionTarget2, convolutionReplacement2)
      .borrow(convolutionSub, () => ({}))
        .replaceNode(convolutionTarget3, convolutionReplacement3)
        .replaceNode(convolutionTarget4, convolutionReplacement4)
      .finalise(convolutionFinalise("fixture-convolution-two-sites", "GH-291-two-sites"))

    expect(twoSites.name).toBe("fixture-convolution-two-sites")
  })
})

describe("applyModifiers — the pure fold over hand-built step lists", () => {
  // applyModifiers reads only blueprint.name/steps; close is never called by the fold itself, so a
  // fixture that throws if reached still proves the fold stays pure.
  const blueprintOf = (steps: readonly Step[]): Blueprint => ({
    name: "fixture-blueprint",
    steps,
    applied: 0,
    close: () => {
      throw new Error("applyModifiers must not call close")
    }
  })

  test("a target that matches nothing throws ModifierTargetMissing, naming the real candidates", () => {
    const steps: readonly Step[] = [
      { kind: "when", decision: { name: "flag is set", reads: ["flag"], test: () => true }, node: guarded, wire: () => ({}), keep: {} }
    ]
    const modifiers: readonly Modifier[] = [{ kind: "removeWhen", target: notify }]

    const error = thrown(ModifierTargetMissing, () => applyModifiers(blueprintOf(steps), modifiers))

    expect(error.offered).toEqual(["fixture-guarded"])
  })

  test("a target that matches twice (both sides of a fork) throws ModifierTargetAmbiguous, naming which sides matched", () => {
    const steps: readonly Step[] = [
      { kind: "fork", left: notify, wireLeft: () => ({}), right: notify, wireRight: () => ({}) }
    ]
    const modifiers: readonly Modifier[] = [{ kind: "replaceNode", target: notify, replacement: quietNotify }]

    const error = thrown(ModifierTargetAmbiguous, () => applyModifiers(blueprintOf(steps), modifiers))

    expect(error.matched).toEqual(["fork[0].left", "fork[0].right"])
  })

  test("two modifiers naming one target conflict, regardless of what they are", () => {
    const steps: readonly Step[] = [{ kind: "node", node: notify, wire: () => ({}), modifiers: [] }]
    const modifiers: readonly Modifier[] = [
      { kind: "replaceNode", target: notify, replacement: quietNotify },
      { kind: "removeWhen", target: notify }
    ]

    expect(() => applyModifiers(blueprintOf(steps), modifiers)).toThrow(ModifierConflict)
  })

  test("removeWhen rewrites a when step into an unconditional node step, keeping its wire and keep", () => {
    const wire = () => ({})
    const keep = { guardedRan: (a: { readonly ran: boolean }) => a.ran }
    const steps: readonly Step[] = [
      { kind: "when", decision: { name: "flag is set", reads: ["flag"], test: () => true }, node: guarded, wire, keep }
    ]

    const result = applyModifiers(blueprintOf(steps), [{ kind: "removeWhen", target: guarded }])

    expect(result).toEqual([{ kind: "node", node: guarded, wire, keep, modifiers: [] }])
  })

  test("replaceNode swaps a step's node, keeping its wire", () => {
    const wire = () => ({})
    const steps: readonly Step[] = [{ kind: "node", node: notify, wire, modifiers: [] }]

    const result = applyModifiers(blueprintOf(steps), [
      { kind: "replaceNode", target: notify, replacement: quietNotify }
    ])

    expect(result).toEqual([{ kind: "node", node: quietNotify, wire, modifiers: [] }])
  })
})

describe("Graph.shapeOf / projectSteps", () => {
  test("every stage kind projects — fork's two branches, when's decision and guarded node, via, and a borrowed construct as a nested group", () => {
    const shape = Graph.shapeOf(host)
    expect(shape).toBeDefined()
    if (shape === undefined) return

    expect(shape.schema).toBe("mag/shape@1")
    expect(shape.root).toBe("fixture-construct-host")

    const byId = new Map(shape.elements.map((element) => [element.id, element]))
    expect(byId.get("fixture-construct-host")).toEqual({
      kind: "group",
      id: "fixture-construct-host",
      label: "fixture-construct-host",
      parent: null
    })

    // The borrowed construct is a nested group, not an opaque box.
    const containerId = "fixture-construct-host/0:group:fixture-construct"
    expect(byId.get(containerId)).toEqual({
      kind: "group",
      id: containerId,
      label: "fixture-construct",
      parent: "fixture-construct-host"
    })

    // The fork is one element with two branch edges.
    const forkId = `${containerId}/0:fork`
    const leftId = `${containerId}/0:left:fixture-left`
    const rightId = `${containerId}/0:right:fixture-right`
    expect(byId.get(forkId)).toEqual({ kind: "fork", id: forkId, label: "fork", parent: containerId })
    expect(byId.get(leftId)).toEqual({ kind: "node", id: leftId, label: "fixture-left", parent: containerId })
    expect(byId.get(rightId)).toEqual({ kind: "node", id: rightId, label: "fixture-right", parent: containerId })
    expect(shape.edges).toContainEqual({ kind: "branch", from: forkId, to: leftId, label: "left" })
    expect(shape.edges).toContainEqual({ kind: "branch", from: forkId, to: rightId, label: "right" })

    // A borrowed non-construct (`joiner` publishes no blueprint of its own) is a plain node element.
    const joinId = `${containerId}/1:node:fixture-join`
    expect(byId.get(joinId)).toEqual({ kind: "node", id: joinId, label: "fixture-join", parent: containerId })

    // The `.when` is one decision element with a branch edge to the node it guards.
    const decisionId = `${containerId}/2:decision:flag is set`
    const guardedId = `${containerId}/2:node:fixture-guarded`
    expect(byId.get(decisionId)).toEqual({ kind: "decision", id: decisionId, label: "flag is set", parent: containerId })
    expect(byId.get(guardedId)).toEqual({ kind: "node", id: guardedId, label: "fixture-guarded", parent: containerId })
    expect(shape.edges).toContainEqual({ kind: "branch", from: decisionId, to: guardedId, label: "true" })

    // A `.via` stage is a stage too, labelled with its own declared name.
    const viaId = `${containerId}/3:node:uppercase`
    expect(byId.get(viaId)).toEqual({ kind: "node", id: viaId, label: "uppercase", parent: containerId })

    // The chain sequences stage to stage inside the borrowed group.
    expect(shape.edges).toContainEqual({ kind: "sequence", from: forkId, to: joinId })
    expect(shape.edges).toContainEqual({ kind: "sequence", from: joinId, to: decisionId })
    expect(shape.edges).toContainEqual({ kind: "sequence", from: decisionId, to: viaId })
  })

  test("disconfirming, the direct proof of 'no node runs': shapeOf never invokes a node's run", () => {
    let runs = 0
    const counted = make({
      name: "fixture-counted",
      description: "Its run increments a module counter; shapeOf must never trip it.",
      input: Schema.Struct({}),
      success: Schema.Struct({}),
      run: () => {
        runs++
        return Effect.succeed({})
      }
    })
    const counter = Graph.construct<Record<string, never>>("fixture-counter")
      .then(counted, () => ({}))
      .finalise({
        description: "One node whose run is counted, projected without running it.",
        input: Schema.Struct({}),
        success: Schema.Struct({}),
        scope: () => ({ ticket: "GH-331-counter", graph: "fixture-counter", worktree: false }),
        seed: (input) => input,
        out: () => ({})
      })

    const shape = Graph.shapeOf(counter)

    expect(shape?.elements.some((element) => element.label === "fixture-counted")).toBe(true)
    expect(runs).toBe(0)
  })

  test("a bent borrow projects its bent stages: the unbent group keeps the decision, the bent one shows a plain node", () => {
    const bentShape = Graph.shapeOf(bentHost)
    const plainShape = Graph.shapeOf(plainHost)
    expect(bentShape).toBeDefined()
    expect(plainShape).toBeDefined()
    if (bentShape === undefined || plainShape === undefined) return

    expect(plainShape.elements.some((element) => element.kind === "decision" && element.label === "flag is set")).toBe(true)
    expect(bentShape.elements.some((element) => element.kind === "decision")).toBe(false)
    expect(bentShape.elements.some((element) => element.kind === "node" && element.label === "fixture-guarded")).toBe(true)
    expect(bentShape.elements.some((element) => element.kind === "node" && element.label === "fixture-quiet-notify")).toBe(true)
    expect(bentShape.elements.some((element) => element.label === "fixture-notify")).toBe(false)
  })

  test("Graph.shapeOf on a graph({ pipeline }) node returns undefined: it declares no inner shape", () => {
    const plain = graph({
      name: "fixture-plain-graph",
      description: "No blueprint: built as graph({ pipeline }), not Graph.construct.",
      input: Schema.Struct({}),
      success: Schema.Struct({}),
      scope: () => ({ ticket: "GH-331-plain", graph: "fixture-plain-graph", worktree: false }),
      pipeline: () => Effect.succeed({})
    })

    expect(Graph.shapeOf(plain)).toBeUndefined()
  })

  test("projectSteps is the fold Graph.shapeOf is built from: callable directly over a hand-built step list", () => {
    const wire = () => ({})
    const steps: readonly Step[] = [{ kind: "node", node: notify, wire, modifiers: [] }]

    const { elements, edges } = projectSteps("fixture-root", steps)

    expect(elements).toEqual([
      { kind: "node", id: "fixture-root/0:node:fixture-notify", label: "fixture-notify", parent: "fixture-root" }
    ])
    expect(edges).toEqual([])
  })

  test("a declared read draws a data edge from the keep that produced the field", () => {
    const steps: readonly Step[] = [
      {
        kind: "node",
        node: notify,
        wire: () => ({}),
        keep: { tag: (a: { readonly notified: string }) => a.notified },
        modifiers: []
      },
      {
        kind: "when",
        decision: { name: "tag is loud", reads: ["tag"], test: () => true },
        node: guarded,
        wire: () => ({}),
        keep: {}
      }
    ]

    const { edges } = projectSteps("fixture-root", steps)

    expect(edges).toContainEqual({
      kind: "data",
      from: "fixture-root/0:node:fixture-notify",
      to: "fixture-root/1:decision:tag is loud",
      field: "tag"
    })
  })

  test("a keep-less stage produces every field of its node's success", () => {
    const steps: readonly Step[] = [
      { kind: "node", node: notify, wire: () => ({}), modifiers: [] },
      {
        kind: "when",
        decision: { name: "notified at all", reads: ["notified"], test: () => true },
        node: guarded,
        wire: () => ({}),
        keep: {}
      }
    ]

    const { edges } = projectSteps("fixture-root", steps)

    expect(edges).toContainEqual({
      kind: "data",
      from: "fixture-root/0:node:fixture-notify",
      to: "fixture-root/1:decision:notified at all",
      field: "notified"
    })
  })

  test("a seeded read arrives from the container itself, the entry of the graph", () => {
    const steps: readonly Step[] = [
      {
        kind: "when",
        decision: { name: "flag is set", reads: ["flag"], test: () => true },
        node: guarded,
        wire: () => ({}),
        keep: {}
      }
    ]

    const { edges } = projectSteps("fixture-root", steps)

    expect(edges).toContainEqual({
      kind: "data",
      from: "fixture-root",
      to: "fixture-root/0:decision:flag is set",
      field: "flag"
    })
  })

  test("disconfirming: a read below a stage whose fields cannot be enumerated refuses, naming the opaque stage", () => {
    const steps: readonly Step[] = [
      { kind: "node", node: unenumerable, wire: () => ({}), modifiers: [] },
      {
        kind: "when",
        decision: { name: "x is set", reads: ["x"], test: () => true },
        node: guarded,
        wire: () => ({}),
        keep: {}
      }
    ]

    const error = thrown(FieldHasNoProducer, () => projectSteps("fixture-root", steps))

    expect(error.field).toBe("x")
    expect(error.opaque).toEqual(["fixture-root/0:node:fixture-unenumerable"])
  })

  test("disconfirming: an index-signature success is also opaque — its named fields are not an exhaustive list", () => {
    const steps: readonly Step[] = [
      { kind: "node", node: indexSigned, wire: () => ({}), modifiers: [] },
      {
        kind: "when",
        decision: { name: "x is set", reads: ["x"], test: () => true },
        node: guarded,
        wire: () => ({}),
        keep: {}
      }
    ]

    const error = thrown(FieldHasNoProducer, () => projectSteps("fixture-root", steps))

    expect(error.field).toBe("x")
    expect(error.opaque).toEqual(["fixture-root/0:node:fixture-index-signed"])
  })

  test("two decisions sharing a name in one container refuse: a name is an address", () => {
    const decision = { name: "flag is set", reads: ["flag"], test: () => true }
    const steps: readonly Step[] = [
      { kind: "when", decision, node: guarded, wire: () => ({}), keep: {} },
      { kind: "when", decision, node: guarded, wire: () => ({}), keep: {} }
    ]

    const error = thrown(DecisionNameCollides, () => projectSteps("fixture-root", steps))

    expect(error.container).toBe("fixture-root")
    expect(error.decision).toBe("flag is set")
  })

  test("a construct whose decisions cannot be drawn refuses at .finalise, before any run", () => {
    // Declared inside the test body: a top-level throw at module evaluation would take the whole
    // suite down with it, since `.finalise` runs at declaration time.
    const error = thrown(DecisionNameCollides, () =>
      Graph.construct<{ flag: boolean }>("fixture-colliding-host")
        .when({ name: "flag is set", reads: ["flag"], test: (s) => s.flag }, guarded, () => ({}), {})
        .when({ name: "flag is set", reads: ["flag"], test: (s) => s.flag }, guarded, () => ({}), {})
        .finalise({
          description: "Two decisions at one address — refused when the construct closes.",
          input: Schema.Struct({ flag: Schema.Boolean }),
          success: Schema.Struct({}),
          scope: () => ({ ticket: "GH-332-colliding", graph: "fixture-colliding-host", worktree: false }),
          seed: (input) => input,
          out: () => ({})
        }))

    expect(error.decision).toBe("flag is set")
  })
})

// Compile-time pin, following the `.finalise` error-union pin above: `Graph.shapeOf`'s return type
// extends `GraphShape | undefined` and is not silently erased to `undefined` alone — the mechanical
// proof that `.finalise` itself is untouched; this reads the blueprint beside it.
type ShapeOfReturn = ReturnType<typeof Graph.shapeOf>
const _shapeOfReturnsShapeOrUndefined: Extends<ShapeOfReturn, GraphShape | undefined> = true
const _shapeOfNotErasedToUndefinedAlone: Extends<GraphShape, ShapeOfReturn> = true

describe("Graph.shapeOf — return type stays GraphShape | undefined", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_shapeOfReturnsShapeOrUndefined).toBe(true)
    expect(_shapeOfNotErasedToUndefinedAlone).toBe(true)
  })
})
