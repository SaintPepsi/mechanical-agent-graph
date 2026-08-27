import { describe, expect, test } from "bun:test"
import { Cause, Data, Effect, Exit, Fiber, Option, Schema } from "effect"
import { badArgument } from "effect/PlatformError"
import { type GraphNode, make } from "mag/runtime/graph-node.definition"
import { sameInput } from "mag/runtime/journal/canonical"
import { journaled } from "mag/runtime/journal/journaled"
import { isEndRow, isStartRow, type JournalRow } from "mag/runtime/journal/row"
import { Journal, type JournalService } from "mag/runtime/journal/service"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"

const RUN: RunInfoService = {
  runId: "run-2",
  ticket: "GH-120",
  graph: "branch-name",
  repoRoot: "/home/dev/repo",
  workRoot: "/home/dev/repo",
  recordsRoot: "/home/dev/repo",
  records: "run-root",
  sha: "abc1234",
  pipelineSha: "def4567",
  runRoot: "/home/dev/.claude/graph/repo-1a2b3c4d/GH-120/run-2"
}

/** What a predecessor run recorded for one node: the input it saw, and the success it wrote (or did not). */
interface Recorded {
  readonly node: string
  readonly input: Option.Option<unknown>
  readonly success: Option.Option<unknown>
}

/**
 * An in-memory `JournalService` with the same matching rule the live one uses (`sameInput`), so a
 * test can drive `journaled` through every replay decision without a filesystem in the way. `rows`
 * is what the run under test wrote; `failAppend` fails every append (what a write failure on the
 * FIRST append — the entered entry — looks like); `failEndAppend` fails only `event: "end"` appends,
 * so the entered entry lands and the node itself runs before the write failure hits, which is what
 * exercises `journaled`'s `joiningCause` behaviour.
 */
const fakeJournal = (
  predecessor: readonly Recorded[] = [],
  options: { readonly failAppend?: boolean; readonly failEndAppend?: boolean; readonly slowAppend?: boolean } = {}
) => {
  const rows: JournalRow[] = []
  const attempts = new Map<string, number>()

  // A real append is a filesystem write, which yields. `slowAppend` models that yield point, which
  // is the only place an interrupt can cut the write short.
  const push = (row: JournalRow) =>
    options.slowAppend === true
      ? Effect.sleep("20 millis").pipe(Effect.map(() => {
        rows.push(row)
      }))
      : Effect.sync(() => {
        rows.push(row)
      })

  const fails = (row: JournalRow) => options.failAppend === true || (options.failEndAppend === true && isEndRow(row))

  const service: JournalService = {
    recorded: (node, _attempt, input) =>
      Effect.sync(() => {
        const hit = predecessor.findLast((entry) => entry.node === node && sameInput(entry.input, input))
        return hit === undefined ? Option.none() : hit.success
      }),
    attempt: (node) =>
      Effect.sync(() => {
        const next = (attempts.get(node) ?? 0) + 1
        attempts.set(node, next)
        return next
      }),
    append: (row) => (fails(row) ? Effect.fail(badArgument({ module: "FileSystem", method: "writeFileString" })) : push(row))
  }

  return { service, rows }
}

const runWith = <A, E>(effect: Effect.Effect<A, E>, journal: JournalService) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(Journal, journal), Effect.provideService(RunInfo, RUN)))

const Input = Schema.Struct({ ticket: Schema.String })
const Success = Schema.Struct({ title: Schema.String })

class Boom extends Data.TaggedError("BOOM")<{ readonly detail: string }> {}

/**
 * A BARE node — an object literal, never `make` — so these tests exercise `journaled` itself.
 * `make` applies `journaled` for real code (`graph-node.definition.ts`), which would leave every
 * assertion below passing against an already-wrapped node and prove nothing about the wrapper.
 */
const bare = (run: () => Effect.Effect<{ title: string }, Boom>): GraphNode<
  { readonly ticket: string },
  { readonly title: string },
  Boom,
  never
> => ({ name: "fetch-ticket", description: "Test node.", input: Input, success: Success, run })

/** A bare node that counts how many times its body actually ran — how a skipped run is proved, not assumed. */
const counting = (body: () => Effect.Effect<{ title: string }, Boom>) => {
  let calls = 0
  const node = bare(() => {
    calls += 1
    return body()
  })
  return { node, calls: () => calls }
}

const succeeds = () => counting(() => Effect.succeed({ title: "t" }))

/** Both journal row shapes carry an `event`, so the `undefined` branch is unreachable. */
const eventOf = (row: JournalRow): string | undefined => (isStartRow(row) ? row.event : isEndRow(row) ? row.event : undefined)

describe("journaled — running", () => {
  test("a successful run appends a start entry, then an end entry carrying the input and success", async () => {
    const journal = fakeJournal()
    const { node } = succeeds()

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(exit).toStrictEqual(Exit.succeed({ title: "t" }))
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[0]).toMatchObject({
      node: "fetch-ticket",
      runId: "run-2",
      graph: "branch-name",
      attempt: 1,
      event: "start",
      input: { ticket: "GH-120" }
    })
    expect(journal.rows[1]).toMatchObject({
      node: "fetch-ticket",
      attempt: 1,
      event: "end",
      replayed: false,
      outcome: "ok",
      input: { ticket: "GH-120" },
      success: { title: "t" }
    })
  })

  test("the start entry's timestamp precedes the end entry's, and neither carries a duration field", async () => {
    const journal = fakeJournal()
    const { node } = succeeds()

    await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)
    const [start, end] = journal.rows
    if (!isStartRow(start!) || !isEndRow(end!)) throw new Error("expected a start/end pair")

    expect(Date.parse(start.timestamp)).not.toBeNaN()
    expect(Date.parse(end.timestamp)).not.toBeNaN()
    expect(Date.parse(end.timestamp)).toBeGreaterThanOrEqual(Date.parse(start.timestamp))
    expect(Object.hasOwn(start, "ms")).toBe(false)
    expect(Object.hasOwn(end, "ms")).toBe(false)
    expect(Object.hasOwn(start, "startedAt")).toBe(false)
    expect(Object.hasOwn(end, "endedAt")).toBe(false)
  })

  test("the start entry lands before the node's own work runs, so a node that fails still leaves it", async () => {
    const journal = fakeJournal()
    const { node } = counting(() => Effect.fail(new Boom({ detail: "d" })))

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(exit).toStrictEqual(Exit.fail(new Boom({ detail: "d" })))
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[0]).toMatchObject({ node: "fetch-ticket", attempt: 1, event: "start" })
    expect(journal.rows[1]).toMatchObject({ event: "end", outcome: "fail", tag: "BOOM", replayed: false })
    expect(Object.hasOwn(journal.rows[1]!, "success")).toBe(false)
  })

  test("a defect records outcome die and stays a defect", async () => {
    const journal = fakeJournal()
    const node = bare(() => Effect.die("raw") as Effect.Effect<{ title: string }, Boom>)

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[1]).toMatchObject({ event: "end", outcome: "die" })
  })

  test("a self-interrupting run records outcome interrupt", async () => {
    const journal = fakeJournal()
    const node = bare(() => Effect.interrupt as Effect.Effect<{ title: string }, Boom>)

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[1]).toMatchObject({ event: "end", outcome: "interrupt" })
  })

  test("an interrupt arriving once the node is running still lands the exit entry", async () => {
    // `Effect.onExit` runs its finalizer uninterruptibly by construction,
    // so the exit append completes even though the fiber already carries a pending interrupt. The
    // interrupt is timed to land after the (interruptible) entered-entry append has finished — see
    // `journaled.ts`'s comment on that append for why it is not itself protected — so this exercises
    // `onExit`'s guarantee on the append that actually needs it.
    const journal = fakeJournal([], { slowAppend: true })
    const node = bare(() => Effect.never as Effect.Effect<{ title: string }, Boom>)

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(journaled(node).run({ ticket: "GH-120" }))
      yield* Effect.sleep("30 millis")
      yield* Fiber.interrupt(fiber)
    })

    await Effect.runPromise(
      program.pipe(Effect.provideService(Journal, journal.service), Effect.provideService(RunInfo, RUN))
    )

    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[0]).toMatchObject({ event: "start" })
    expect(journal.rows[1]).toMatchObject({ event: "end", outcome: "interrupt", replayed: false })
  })

  test("an interrupt arriving mid-append on the entered entry leaves no torn record", async () => {
    // The entered-entry append is left interruptible (see `journaled.ts`). An interrupt landing
    // while it is in flight cuts the write short before the row is pushed at all — never a torn
    // half-written row — and `node.run` is never reached, so no exit entry follows either.
    const journal = fakeJournal([], { slowAppend: true })
    const { node, calls } = counting(() => Effect.succeed({ title: "t" }))

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(journaled(node).run({ ticket: "GH-120" }))
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(fiber)
    })

    await Effect.runPromise(
      program.pipe(Effect.provideService(Journal, journal.service), Effect.provideService(RunInfo, RUN))
    )

    expect(journal.rows).toHaveLength(0)
    expect(calls()).toBe(0)
  })

  test("re-entering a node increments attempt rather than overwriting its entries", async () => {
    const journal = fakeJournal()
    const { node } = succeeds()
    const wrapped = journaled(node)

    await runWith(
      Effect.flatMap(wrapped.run({ ticket: "GH-120" }), () => wrapped.run({ ticket: "GH-120" })),
      journal.service
    )

    expect(journal.rows.map((row) => [row.attempt, eventOf(row)])).toStrictEqual([
      [1, "start"],
      [1, "end"],
      [2, "start"],
      [2, "end"]
    ])
  })

  test("a write failure on the entered entry ends the run as a defect before the node ever runs", async () => {
    const journal = fakeJournal([], { failAppend: true })
    const { node, calls } = succeeds()

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    // A defect, not a failure: `PlatformError` is nowhere in the node's own error channel, so a
    // caller could never have handled it, and `Effect.orDie` is what says so.
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? exit.cause : undefined
    expect(cause?.reasons.some(Cause.isDieReason)).toBe(true)
    expect(cause?.reasons.some(Cause.isFailReason)).toBe(false)
    expect(journal.rows).toHaveLength(0)
    expect(calls()).toBe(0)
  })

  test("a write failure on the exit entry joins the node's own failure instead of erasing it", async () => {
    const journal = fakeJournal([], { failEndAppend: true })
    const { node } = counting(() => Effect.fail(new Boom({ detail: "the real problem" })))

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    // A failing finalizer REPLACES the exit (`onExit` is `flatMap(finalizer, () => exit)`), so
    // without `joiningCause` the operator would see only "disk full" and never why the node
    // failed. Both reasons must be present: the node's typed failure and the journal's defect.
    expect(Exit.isFailure(exit)).toBe(true)
    const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
    expect(reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof Boom)).toBe(true)
    expect(reasons.some(Cause.isDieReason)).toBe(true)
    // The entered entry itself landed fine — only the exit append failed.
    expect(journal.rows).toHaveLength(1)
    expect(journal.rows[0]).toMatchObject({ event: "start" })
  })

  test("a success the schema encodes but JSON cannot render lands an end entry without success", async () => {
    const journal = fakeJournal()
    // `Schema.Unknown` encodes a bigint untouched; `JSON.stringify` throws on it. The guard turns
    // that into an absent `success` field — the same shape as a schema-refused value — instead of
    // a TypeError thrown inside the append, which would kill the run the row is recording.
    const node: GraphNode<{ readonly ticket: string }, unknown, Boom, never> = {
      name: "fetch-ticket",
      description: "Test node.",
      input: Input,
      success: Schema.Unknown,
      run: () => Effect.succeed({ big: 1n })
    }

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[1]).toMatchObject({ event: "end", outcome: "ok" })
    expect(Object.hasOwn(journal.rows[1]!, "success")).toBe(false)
  })
})

describe("journaled — replaying", () => {
  const previously: readonly Recorded[] = [
    { node: "fetch-ticket", input: Option.some({ ticket: "GH-120" }), success: Option.some({ title: "recorded" }) }
  ]

  test("a recorded success is returned without running the node", async () => {
    const journal = fakeJournal(previously)
    const { node, calls } = succeeds()

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(exit).toStrictEqual(Exit.succeed({ title: "recorded" }))
    expect(calls()).toBe(0)
  })

  test("a replay writes its own start/end pair, so the resumed run's journal is complete on its own", async () => {
    const journal = fakeJournal(previously)
    const { node } = succeeds()

    await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[0]).toMatchObject({ node: "fetch-ticket", runId: "run-2", attempt: 1, event: "start" })
    expect(journal.rows[1]).toMatchObject({
      node: "fetch-ticket",
      runId: "run-2",
      attempt: 1,
      event: "end",
      replayed: true,
      outcome: "ok",
      success: { title: "recorded" }
    })
  })

  test("a different input runs fresh", async () => {
    const journal = fakeJournal(previously)
    const { node, calls } = succeeds()

    const exit = await runWith(journaled(node).run({ ticket: "GH-999" }), journal.service)

    expect(exit).toStrictEqual(Exit.succeed({ title: "t" }))
    expect(calls()).toBe(1)
    expect(journal.rows[1]).toMatchObject({ event: "end", replayed: false })
  })

  test("a recorded success that no longer decodes runs fresh", async () => {
    const journal = fakeJournal([
      { node: "fetch-ticket", input: Option.some({ ticket: "GH-120" }), success: Option.some({ headline: "moved on" }) }
    ])
    const { node, calls } = succeeds()

    const exit = await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(exit).toStrictEqual(Exit.succeed({ title: "t" }))
    expect(calls()).toBe(1)
    expect(journal.rows[1]).toMatchObject({ event: "end", replayed: false })
  })

  test("an ok row that recorded no success runs fresh", async () => {
    const journal = fakeJournal([
      { node: "fetch-ticket", input: Option.some({ ticket: "GH-120" }), success: Option.none() }
    ])
    const { node, calls } = succeeds()

    await runWith(journaled(node).run({ ticket: "GH-120" }), journal.service)

    expect(calls()).toBe(1)
    expect(journal.rows[1]).toMatchObject({ event: "end", replayed: false })
  })
})

describe("journaled — the wrapper itself", () => {
  test("wrapping a wrapped node returns it unchanged", () => {
    const { node } = succeeds()
    const once = journaled(node)

    expect(journaled(once)).toBe(once)
  })

  test("double wrapping writes one start/end pair, not two", async () => {
    const journal = fakeJournal()
    const { node } = succeeds()

    await runWith(journaled(journaled(node)).run({ ticket: "GH-120" }), journal.service)

    expect(journal.rows).toHaveLength(2)
  })

  test("the node's own identity and schemas survive the wrap", () => {
    const { node } = succeeds()
    const wrapped = journaled(node)

    expect(wrapped.name).toBe(node.name)
    expect(wrapped.description).toBe(node.description)
    expect(wrapped.input).toBe(node.input)
    expect(wrapped.success).toBe(node.success)
  })

  test("with no journal provided, the node runs and nothing is recorded", async () => {
    const { node, calls } = succeeds()

    const exit = await Effect.runPromiseExit(journaled(node).run({ ticket: "GH-120" }))

    expect(exit).toStrictEqual(Exit.succeed({ title: "t" }))
    expect(calls()).toBe(1)
  })

  test("an interrupt arriving mid-replay-append still lands the replayed pair", async () => {
    // The replay pair's appends are a plain yield inside one `Effect.uninterruptible` block, not an
    // `onExit` finalizer, so the block has to ask for uninterruptibility itself — without it, a
    // supervisor kill during the write would end the run with a torn pair, or none at all.
    const journal = fakeJournal(
      [{ node: "fetch-ticket", input: Option.some({ ticket: "GH-120" }), success: Option.some({ title: "recorded" }) }],
      { slowAppend: true }
    )
    const node = bare(() => Effect.never as Effect.Effect<{ title: string }, Boom>)

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(journaled(node).run({ ticket: "GH-120" }))
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(fiber)
    })

    await Effect.runPromise(
      program.pipe(Effect.provideService(Journal, journal.service), Effect.provideService(RunInfo, RUN))
    )

    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[0]).toMatchObject({ event: "start" })
    expect(journal.rows[1]).toMatchObject({ event: "end", replayed: true, outcome: "ok" })
  })

  // The invariant CLAUDE.md states as "extend the definition, not every node": `make` is the one
  // seam every node, phase and graph passes through, so journalling holds by construction. This is
  // the guard on that — a `make` that stops applying `journaled` fails here, loudly, instead of
  // leaving every node silently unrecorded.
  test("a node built by `make` alone is already journalled", async () => {
    const journal = fakeJournal()
    const node = make(bare(() => Effect.succeed({ title: "t" })))

    await runWith(node.run({ ticket: "GH-120" }), journal.service)

    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[1]).toMatchObject({ node: "fetch-ticket", event: "end", outcome: "ok" })
  })

  test("a node derived by spreading a made node is journalled in its own right", async () => {
    // The marker is a non-enumerable symbol precisely so spread does NOT carry it: if it did,
    // `make` would see the inherited marker on the derivation, skip the wrap, and produce a node
    // that runs with zero rows — the silent drift the constructor exists to prevent.
    const base = make(bare(() => Effect.succeed({ title: "base" })))
    const derived = make({
      ...base,
      name: "derived",
      run: () => Effect.succeed({ title: "derived" })
    })

    const journal = fakeJournal()
    const exit = await runWith(derived.run({ ticket: "GH-120" }), journal.service)

    expect(exit).toStrictEqual(Exit.succeed({ title: "derived" }))
    expect(journal.rows).toHaveLength(2)
    expect(journal.rows[1]).toMatchObject({ node: "derived", event: "end", outcome: "ok" })
  })
})
