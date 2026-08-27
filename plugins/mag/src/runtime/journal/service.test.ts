import { describe, expect, test } from "bun:test"
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { isEndRow, isStartRow, type JournalRow, JournalRowSchema, ranEndRow, startRow } from "mag/runtime/journal/row"
import { Journal, journalLayer } from "mag/runtime/journal/service"
import { platform } from "mag/runtime/platform"
import { journalPathFor } from "mag/runtime/run-root"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"

const Input = Schema.Struct({ ticket: Schema.String })
const Success = Schema.Struct({ title: Schema.String })

const runInfoFor = (runId: string, graph = "branch-name"): RunInfoService => ({
  runId,
  ticket: "GH-120",
  graph,
  repoRoot: "/home/dev/repo",
  workRoot: "/home/dev/repo",
  recordsRoot: "/home/dev/repo",
  records: "run-root",
  sha: "abc1234",
  pipelineSha: "def4567",
  runRoot: `/home/dev/.claude/graph/repo-1a2b3c4d/GH-120/${runId}`
})

/**
 * A leaf that counts its real runs, so "replayed" is proved by the body not executing.
 *
 * Built with `make` and nothing else — the path a real node takes. `make` applies `journaled`
 * (`graph-node.definition.ts`), so these end-to-end tests exercise the same construction every
 * node in the tree gets, with no test-only wrapping to make the journal appear.
 */
const countingNode = (name: string, title: string) => {
  let calls = 0
  const node = make({
    name,
    description: "Test node.",
    input: Input,
    success: Success,
    run: () => {
      calls += 1
      return Effect.succeed({ title })
    }
  })
  return { node, calls: () => calls }
}

/** Every test runs inside a scoped temp directory that stands in for `~/.claude/graph`. */
const inTempConfigDir = <A, E>(
  body: (
    paths: { readonly journalFor: (runId: string) => string; readonly fs: FileSystem.FileSystem }
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
): Promise<A> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    const journalFor = (runId: string) =>
      journalPathFor({ env: {}, home, repoPath: "/home/dev/repo", ticket: "GH-120", runId })
    return yield* body({ journalFor, fs })
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.runPromise) as Promise<A>

const readRows = (fs: FileSystem.FileSystem, path: string) =>
  Effect.map(fs.readFileString(path), (text) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => Schema.decodeUnknownSync(JournalRowSchema)(JSON.parse(line) as unknown)))

/** Both journal row shapes carry an `event`, so the `undefined` branch is unreachable. */
const eventOf = (row: JournalRow): string | undefined => (isStartRow(row) ? row.event : isEndRow(row) ? row.event : undefined)

describe("journalLayer — writing", () => {
  test("the run directory is created and every row appends to one file", async () => {
    const rows = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const fetch = countingNode("fetch-ticket", "t")
        const format = countingNode("format-branch-name", "b")

        yield* Effect.gen(function* () {
          yield* fetch.node.run({ ticket: "GH-120" })
          yield* format.node.run({ ticket: "GH-120" })
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        return yield* readRows(fs, path)
      })
    )

    // A node's start entry precedes its end entry, and every entry is stamped with the run.
    expect(rows.map((row) => [row.node, eventOf(row)])).toStrictEqual([
      ["fetch-ticket", "start"],
      ["fetch-ticket", "end"],
      ["format-branch-name", "start"],
      ["format-branch-name", "end"]
    ])
    expect(rows.every((row) => row.runId === "run-1")).toBe(true)
    expect(rows.filter(isEndRow).every((row) => row.replayed === false)).toBe(true)
  })

  test("a second layer build appends rather than truncating", async () => {
    const rows = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const write = (runId: string) =>
          Effect.flatMap(Journal, (journal) =>
            journal.append(
              ranEndRow({
                run: runInfoFor(runId),
                node: "fetch-ticket",
                attempt: 1,
                input: Option.some({ ticket: "GH-120" }),
                timestamp: "2026-08-18T12:00:01.000Z",
                exit: Exit.succeed({ title: "t" }),
                success: Option.some({ title: "t" })
              })
            )).pipe(Effect.provide(journalLayer({ graph: "branch-name", path, predecessor: Option.none() })))

        yield* write("run-a")
        yield* write("run-b")

        return yield* readRows(fs, path)
      })
    )

    expect(rows.map((row) => row.runId)).toStrictEqual(["run-a", "run-b"])
  })

  test("attempt counts per node, not across the run", async () => {
    const rows = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const fetch = countingNode("fetch-ticket", "t")
        const format = countingNode("format-branch-name", "b")

        yield* Effect.gen(function* () {
          yield* fetch.node.run({ ticket: "A" })
          yield* format.node.run({ ticket: "A" })
          yield* fetch.node.run({ ticket: "B" })
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        return yield* readRows(fs, path)
      })
    )

    expect(rows.filter(isEndRow).map((row) => [row.node, row.attempt])).toStrictEqual([
      ["fetch-ticket", 1],
      ["format-branch-name", 1],
      ["fetch-ticket", 2]
    ])
  })
})

describe("journalLayer — resuming", () => {
  /**
   * The shape a resume actually has: run 2 mints a new run id, so it writes into a *different*
   * directory than the one it reads. Its own journal has to be complete on its own — which is what
   * the `replayed: true` rows are for.
   */
  test("a resumed run replays run 1's work and writes its own complete journal", async () => {
    const result = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        const original = countingNode("fetch-ticket", "t")
        yield* original.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        // A resume is a *fresh* process: new node objects, new layer, new run directory.
        const resumed = countingNode("fetch-ticket", "t")
        const value = yield* resumed.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return {
          value,
          reran: resumed.calls(),
          firstRows: yield* readRows(fs, first),
          secondRows: yield* readRows(fs, second)
        }
      })
    )

    expect(result.value).toStrictEqual({ title: "t" })
    expect(result.reran).toBe(0)
    expect(result.firstRows).toHaveLength(2)
    expect(result.firstRows[0]).toMatchObject({ runId: "run-1", event: "start" })
    expect(result.firstRows[1]).toMatchObject({ runId: "run-1", event: "end", replayed: false })

    // Complete on its own: one start/end pair per node the run covered, stamped with *its* run id.
    expect(result.secondRows).toHaveLength(2)
    expect(result.secondRows[0]).toMatchObject({ runId: "run-2", node: "fetch-ticket", event: "start" })
    expect(result.secondRows[1]).toMatchObject({
      runId: "run-2",
      node: "fetch-ticket",
      event: "end",
      replayed: true,
      outcome: "ok",
      success: { title: "t" }
    })
  })

  test("a node the predecessor never reached runs for real", async () => {
    const result = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        yield* countingNode("fetch-ticket", "t").node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        const fetch = countingNode("fetch-ticket", "t")
        const format = countingNode("format-branch-name", "b")
        yield* Effect.gen(function* () {
          yield* fetch.node.run({ ticket: "GH-120" })
          yield* format.node.run({ ticket: "GH-120" })
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { fetchRuns: fetch.calls(), formatRuns: format.calls(), rows: yield* readRows(fs, second) }
      })
    )

    expect(result.fetchRuns).toBe(0)
    expect(result.formatRuns).toBe(1)
    // Each node's start precedes its own end, replayed or not.
    expect(result.rows.map((row) => [row.node, eventOf(row)])).toStrictEqual([
      ["fetch-ticket", "start"],
      ["fetch-ticket", "end"],
      ["format-branch-name", "start"],
      ["format-branch-name", "end"]
    ])
    expect(result.rows.filter(isEndRow).map((row) => [row.node, row.replayed])).toStrictEqual([
      ["fetch-ticket", true],
      ["format-branch-name", false]
    ])
  })

  test("a resume of a resume keeps replaying, rather than re-running the prefix again", async () => {
    const reran = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const paths = ["run-1", "run-2", "run-3"].map(journalFor) as [string, string, string]

        const runs: number[] = []
        for (const [index, path] of paths.entries()) {
          const node = countingNode("fetch-ticket", "t")
          yield* node.node.run({ ticket: "GH-120" }).pipe(
            Effect.provide(
              journalLayer({ graph: "branch-name", path, predecessor: index === 0 ? Option.none() : Option.some(paths[index - 1]!) })
            ),
            Effect.provideService(RunInfo, runInfoFor(`run-${index + 1}`))
          )
          runs.push(node.calls())
        }
        return runs
      })
    )

    expect(reran).toStrictEqual([1, 0, 0])
  })

  test("a torn final line costs that row only, not the rows before it", async () => {
    const result = await inTempConfigDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        yield* countingNode("fetch-ticket", "t").node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )
        // What a run killed mid-append leaves behind.
        yield* fs.writeFileString(first, '{"schema":"graph/journal@3","node":"format-bra', { flag: "a" })

        const fetch = countingNode("fetch-ticket", "t")
        yield* fetch.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { reran: fetch.calls(), rows: yield* readRows(fs, second) }
      })
    )

    expect(result.reran).toBe(0)
    expect(result.rows[0]).toMatchObject({ event: "start" })
    expect(result.rows[1]).toMatchObject({ event: "end", replayed: true })
  })

  test("a predecessor path that does not exist reads as no rows at all", async () => {
    const reran = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const fetch = countingNode("fetch-ticket", "t")
        yield* fetch.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(
            journalLayer({ graph: "branch-name", path: journalFor("run-2"), predecessor: Option.some(journalFor("run-never")) })
          ),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )
        return fetch.calls()
      })
    )

    expect(reran).toBe(1)
  })
})

describe("journalLayer — resuming is positional", () => {
  /** A node whose successive runs return different values, so a mis-replayed position is visible. */
  const sequenceNode = (name: string, values: readonly string[]) => {
    let calls = 0
    const node = make({
      name,
      description: "Test node.",
      input: Input,
      success: Success,
      run: () => {
        const title = values[calls] ?? "exhausted"
        calls += 1
        return Effect.succeed({ title })
      }
    })
    return { node, calls: () => calls }
  }

  test("a node invoked twice with the same input replays each position's own success", async () => {
    // The regression this pins: matching by node + input alone replayed the LAST row into BOTH
    // positions, so a run that recorded ["A", "B"] resumed as ["B", "B"].
    const result = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        const original = sequenceNode("fetch-ticket", ["A", "B"])
        yield* Effect.gen(function* () {
          yield* original.node.run({ ticket: "GH-120" })
          yield* original.node.run({ ticket: "GH-120" })
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        const resumed = sequenceNode("fetch-ticket", ["fresh-1", "fresh-2"])
        const replayed = yield* Effect.gen(function* () {
          const one = yield* resumed.node.run({ ticket: "GH-120" })
          const two = yield* resumed.node.run({ ticket: "GH-120" })
          return [one.title, two.title]
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { replayed, reruns: resumed.calls() }
      })
    )

    expect(result.replayed).toStrictEqual(["A", "B"])
    expect(result.reruns).toBe(0)
  })

  test("a failed attempt replays the LATER same-input success in its place, never an earlier one", async () => {
    const result = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        // Run 1: attempt 1 fails, the caller retries, attempt 2 succeeds — the failed-then-
        // succeeded shape the forward scan exists for.
        let calls = 0
        const flaky = make({
          name: "fetch-ticket",
          description: "Test node.",
          input: Input,
          success: Success,
          run: () => {
            calls += 1
            return calls === 1
              ? Effect.fail(new Error("first attempt fails"))
              : Effect.succeed({ title: "second-attempt" })
          }
        })
        yield* flaky.run({ ticket: "GH-120" }).pipe(
          Effect.catchCause(() => flaky.run({ ticket: "GH-120" })),
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        // Resume: invocation 1 finds attempt 1's fail row, scans FORWARD to attempt 2's success.
        const resumed = countingNode("fetch-ticket", "fresh")
        const value = yield* resumed.node.run({ ticket: "GH-120" }).pipe(
          Effect.catchCause(() => resumed.node.run({ ticket: "GH-120" })),
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { value, reruns: resumed.calls() }
      })
    )

    expect(result.value).toStrictEqual({ title: "second-attempt" })
    expect(result.reruns).toBe(0)
  })

  test("a later invocation never replays an earlier attempt's success backward", async () => {
    const result = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        // Run 1 invoked the node once. The resume invokes it twice: position 1 replays, but
        // position 2 has no row at attempt >= 2, so it must run — attempt 1's success already
        // belongs to invocation 1.
        yield* countingNode("fetch-ticket", "recorded").node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1"))
        )

        const resumed = countingNode("fetch-ticket", "fresh")
        const titles = yield* Effect.gen(function* () {
          const one = yield* resumed.node.run({ ticket: "GH-120" })
          const two = yield* resumed.node.run({ ticket: "GH-120" })
          return [one.title, two.title]
        }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { titles, reruns: resumed.calls() }
      })
    )

    expect(result.titles).toStrictEqual(["recorded", "fresh"])
    expect(result.reruns).toBe(1)
  })

  test("rows from a different graph's run never replay", async () => {
    const result = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        // A predecessor's journal CAN hold another graph's rows (a borrowed subgraph), so this
        // filter is the guard that keeps a resumed run's own value from ever picking up another
        // graph's answer.
        yield* countingNode("fetch-ticket", "other-graphs-answer").node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "other-graph", path: first, predecessor: Option.none() })),
          Effect.provideService(RunInfo, runInfoFor("run-1", "other-graph"))
        )

        const resumed = countingNode("fetch-ticket", "own-answer")
        const value = yield* resumed.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { value, reruns: resumed.calls() }
      })
    )

    expect(result.value).toStrictEqual({ title: "own-answer" })
    expect(result.reruns).toBe(1)
  })

  test("a predecessor's start entry with no matching end never replays — the node re-runs fresh", async () => {
    const result = await inTempConfigDir(({ journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        // What a hard-killed run-1 leaves behind: the entered entry landed, the exit entry never
        // did. `journal.recorded` must treat this exactly like "this node has no predecessor row".
        yield* Effect.flatMap(Journal, (journal) =>
          journal.append(
            startRow({
              run: runInfoFor("run-1"),
              node: "fetch-ticket",
              attempt: 1,
              input: Option.some({ ticket: "GH-120" }),
              timestamp: "2026-08-18T12:00:00.000Z"
            })
          )
        ).pipe(Effect.provide(journalLayer({ graph: "branch-name", path: first, predecessor: Option.none() })))

        const resumed = countingNode("fetch-ticket", "fresh")
        const value = yield* resumed.node.run({ ticket: "GH-120" }).pipe(
          Effect.provide(journalLayer({ graph: "branch-name", path: second, predecessor: Option.some(first) })),
          Effect.provideService(RunInfo, runInfoFor("run-2"))
        )

        return { value, reruns: resumed.calls() }
      })
    )

    expect(result.value).toStrictEqual({ title: "fresh" })
    expect(result.reruns).toBe(1)
  })
})

describe("journalLayer — the no-op default", () => {
  test("with nothing provided a wrapped node runs and writes no file", async () => {
    const { value, calls } = await inTempConfigDir(() =>
      Effect.gen(function* () {
        const fetch = countingNode("fetch-ticket", "t")
        const value = yield* fetch.node.run({ ticket: "GH-120" })
        return { value, calls: fetch.calls() }
      })
    )

    expect(value).toStrictEqual({ title: "t" })
    expect(calls).toBe(1)
  })
})
