import { describe, expect, test } from "bun:test"
import { Effect, Exit, FileSystem, Option, Result } from "effect"
import { ranEndRow, startRow } from "mag/runtime/journal/row"
import { platform } from "mag/runtime/platform"
import { mostReplayable, RESUME_NODE, selectPredecessor, ResumeWithoutPredecessor } from "mag/runtime/resume"
import { testRunInfo } from "mag/test/node-fixture"

/**
 * `resume.ts`'s own test: the pure ranking table first (no filesystem), then `selectPredecessor`'s
 * reader over a real temp directory. Lives beside the module it tests
 * (`resolve-base/graph-node.test.ts`'s convention) and, unlike anything under `graph-nodes/`,
 * is free to stamp a fixture row with a second `graph` value — the "another graph's stamp is never
 * chosen" case below needs exactly that, and `test/node-fixture.ts`'s `testJournalStamp` cannot:
 * it fixes `graph` so every row written through it shares one graph name.
 */

const stamp = (runId: string, node: string, graph = "develop-graph") => ({
  run: testRunInfo({ runId, graph }),
  node,
  attempt: 1,
  input: Option.none(),
  timestamp: "2026-08-20T00:00:00.000Z"
})

/** A completed node: what `journaled.ts` writes on a real `ok` exit. */
const done = (runId: string, node: string, graph?: string) =>
  ranEndRow({ ...stamp(runId, node, graph), exit: Exit.succeed({ ok: true }), success: Option.some({ ok: true }) })

/** A node still running when its run stopped: entered, never exited. */
const entered = (runId: string, node: string, graph?: string) => startRow(stamp(runId, node, graph))

describe("mostReplayable", () => {
  test("the run with more replayable nodes for the graph wins, node count over recency", () => {
    const runs = [
      { runId: "run-a", rows: [done("run-a", "node-1"), done("run-a", "node-2"), done("run-a", "node-3")] },
      { runId: "run-b", rows: [done("run-b", "node-1")] }
    ]

    const chosen = mostReplayable(runs, "develop-graph")

    expect(chosen.pipe(Option.map((run) => run.runId))).toStrictEqual(Option.some("run-a"))
  })

  test("a success the probe refuses is not replayable work: a fuller run of stale rows loses to a newer run whose rows decode", () => {
    const runs = [
      { runId: "run-a", rows: [done("run-a", "node-1"), done("run-a", "node-2"), done("run-a", "node-3")] },
      { runId: "run-b", rows: [done("run-b", "node-1"), done("run-b", "node-4"), done("run-b", "node-5")] }
    ]

    const chosen = mostReplayable(runs, "develop-graph", (node) => node !== "node-2" && node !== "node-3")

    expect(chosen.pipe(Option.map((run) => run.runId))).toStrictEqual(Option.some("run-b"))
  })

  test("counted by distinct node, not by row: a retry-heavy run with fewer nodes loses to a longer single-pass run", () => {
    // run-single: 12 distinct nodes, one row each (12 rows, 12 nodes) — a clean single pass.
    const runSingle = {
      runId: "run-single",
      rows: Array.from({ length: 12 }, (_, i) => done("run-single", `node-${i + 1}`))
    }
    // run-retried: 8 distinct nodes, each recorded 3 times (24 rows, 8 nodes) — a build-under-review
    // node re-entered by its own review loop (`row.ts`'s `attempt`).
    const runRetried = {
      runId: "run-retried",
      rows: Array.from({ length: 8 }, (_, i) => `node-${i + 1}`).flatMap((node) => [
        done("run-retried", node),
        done("run-retried", node),
        done("run-retried", node)
      ])
    }

    const chosen = mostReplayable([runRetried, runSingle], "develop-graph")

    // 24 raw rows for run-retried would win a row-count race; 12 distinct nodes for run-single wins
    // the real one — the count is of distinct nodes, not rows.
    expect(chosen.pipe(Option.map((run) => run.runId))).toStrictEqual(Option.some("run-single"))
    expect(chosen.pipe(Option.map((run) => run.replayable))).toStrictEqual(Option.some(12))
  })

  test("newest run id wins a tie in replayable count", () => {
    const runs = [
      { runId: "20260820000000-a1a1", rows: [done("20260820000000-a1a1", "node-1")] },
      { runId: "20260820010000-b2b2", rows: [done("20260820010000-b2b2", "node-1")] }
    ]

    const chosen = mostReplayable(runs, "develop-graph")

    expect(chosen.pipe(Option.map((run) => run.runId))).toStrictEqual(Option.some("20260820010000-b2b2"))
  })

  test("a node entered but never exited carries no replayable work", () => {
    const runs = [{ runId: "run-a", rows: [entered("run-a", "node-1")] }]

    expect(Option.isNone(mostReplayable(runs, "develop-graph"))).toBe(true)
  })

  test("a run whose rows all carry another graph's stamp is never chosen, even newest and fullest", () => {
    const runs = [
      // Three rows, newest run id, none of them this graph's — a borrowed subgraph's own journal,
      // or simply a sibling run of a different graph that shares this ticket.
      {
        runId: "20260820020000-c3c3",
        rows: [
          done("20260820020000-c3c3", "node-1", "other-graph"),
          done("20260820020000-c3c3", "node-2", "other-graph"),
          done("20260820020000-c3c3", "node-3", "other-graph")
        ]
      },
      // One row, older run id, but it is this graph's — the only eligible answer.
      { runId: "20260820000000-a1a1", rows: [done("20260820000000-a1a1", "node-1", "develop-graph")] }
    ]

    const chosen = mostReplayable(runs, "develop-graph")

    expect(chosen.pipe(Option.map((run) => run.runId))).toStrictEqual(Option.some("20260820000000-a1a1"))
  })

  test("a resume record's own row is not counted as replayable work", () => {
    // The only same-graph row is the predecessor's own resume-run record, not work the graph did.
    const runs = [{ runId: "run-a", rows: [done("run-a", RESUME_NODE)] }]

    expect(Option.isNone(mostReplayable(runs, "develop-graph"))).toBe(true)
  })
})

/** Every test runs inside a scoped temp directory that stands in for one ticket's run directory. */
const inTicketDir = <A, E>(
  body: (paths: { readonly ticketDir: string; readonly fs: FileSystem.FileSystem }) => Effect.Effect<A, E, FileSystem.FileSystem>
): Promise<A> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const ticketDir = yield* fs.makeTempDirectoryScoped()
    return yield* body({ ticketDir, fs })
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.runPromise) as Promise<A>

/** One sibling run directory holding a journal of already-encoded rows. */
const writeSibling = (fs: FileSystem.FileSystem, ticketDir: string, runId: string, rows: readonly unknown[]) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(`${ticketDir}/${runId}`, { recursive: true })
    yield* fs.writeFileString(`${ticketDir}/${runId}/journal.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  })

describe("selectPredecessor", () => {
  test("the most replayable sibling is chosen, its journal path composed from the ticket directory", async () => {
    const { selection, ticketDir } = await inTicketDir(({ fs, ticketDir }) =>
      Effect.gen(function* () {
        yield* writeSibling(fs, ticketDir, "run-a", [done("run-a", "node-1")])
        yield* writeSibling(fs, ticketDir, "run-b", [done("run-b", "node-1"), done("run-b", "node-2")])
        const selection = yield* selectPredecessor({ ticketDir, graph: "develop-graph" })
        return { selection, ticketDir }
      })
    )

    expect(selection.predecessorRunId).toBe("run-b")
    expect(selection.journalPath).toBe(`${ticketDir}/run-b/journal.jsonl`)
    expect(selection.replayable).toBe(2)
    expect(Option.isNone(selection.workRoot)).toBe(true) // run-b never recorded a resume-run row of its own
  })

  test("a missing ticket directory reads as no siblings, and fails honest about inspecting none", async () => {
    const result = await Effect.runPromise(
      Effect.result(selectPredecessor({ ticketDir: "/no/such/ticket/directory", graph: "develop-graph" }).pipe(Effect.provide(platform)))
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ResumeWithoutPredecessor)
    expect((result.failure as ResumeWithoutPredecessor).inspected).toBe(0)
  })

  test("an undecodable sibling journal is dropped from the scan, not fatal, and still counted as inspected", async () => {
    const result = await inTicketDir(({ fs, ticketDir }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${ticketDir}/run-torn`, { recursive: true })
        yield* fs.writeFileString(`${ticketDir}/run-torn/journal.jsonl`, "not json at all\n")
        return yield* Effect.result(selectPredecessor({ ticketDir, graph: "develop-graph" }))
      })
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ResumeWithoutPredecessor)
    expect((result.failure as ResumeWithoutPredecessor).inspected).toBe(1) // seen, just never eligible
  })
})

// Compile-time pin on `selectPredecessor`'s declared error channel: nothing at runtime can
// observe this widening — `construct.test.ts`'s own `.finalise` pin is the precedent for proving a
// type-level fact with a test that exists only to name it.
type SelectPredecessorError = ReturnType<typeof selectPredecessor> extends Effect.Effect<any, infer E, any> ? E : never
type Extends<A, B> = [A] extends [B] ? true : false
const _errorChannelIsResumeWithoutPredecessor: Extends<SelectPredecessorError, ResumeWithoutPredecessor> = true
const _errorChannelIsNotWidened: Extends<unknown, SelectPredecessorError> = false

describe("selectPredecessor — compile-time pin on its declared error channel", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_errorChannelIsResumeWithoutPredecessor).toBe(true)
    expect(_errorChannelIsNotWidened).toBe(false)
  })
})
