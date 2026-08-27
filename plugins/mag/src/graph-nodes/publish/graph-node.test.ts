import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { PushRejected } from "mag/graph-nodes/push-branch/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/publish/examples"
import { publish } from "mag/graph-nodes/publish/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testJournalLayer, testRunInfo } from "mag/test/node-fixture"

/** Like push-branch's and create-pr's own `scriptedShell`: one canned reply per call, in order, recording argv. */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: Array<string[]> = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const ok = (stdout = ""): ShellResult => ({ exitCode: 0, stdout, stderr: "" })
const exit = (exitCode: number, stderr = ""): ShellResult => ({ exitCode, stdout: "", stderr })

const RUN = testRunInfo()

const INPUT = {
  remote: "origin",
  branch: "feat/gh-168",
  host: "github.com",
  slug: "SaintPepsi/mechanical-agent-graph",
  base: "main",
  title: "GH-168: publish is a GraphNode composed of push-branch and create-pr",
  body: "Fixes the NUL-byte crash at the artifact writer.\n\nCloses #168\n\nrun: run-1"
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService, runInfo: RunInfoService = RUN) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, runInfo)))
  )

describe("publish", () => {
  test("the fixtures decode against publish's own schemas", () => {
    if (!isSchemaHandle(publish.input)) throw new Error("publish.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(publish.input)(example)
    if (!isSchemaHandle(publish.success)) throw new Error("publish.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(publish.success)(example)
  })

  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(publish.input)).toBe(true)
    expect(isSchemaHandle(publish.success)).toBe(true)
    expect(publish.name).toBe("publish")
  })

  test("pushes before opening the PR, and returns create-pr's own { url } verbatim", () => {
    const { calls, service } = scriptedShell([
      ok(), // git status --porcelain: clean
      ok("1\n"), // git rev-list --count main..HEAD: ahead
      ok(), // git push
      ok("[]\n"), // gh pr list: no open request
      ok("https://github.com/SaintPepsi/mechanical-agent-graph/pull/12\n") // gh pr create
    ])
    const result = runWith(publish.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ url: "https://github.com/SaintPepsi/mechanical-agent-graph/pull/12" })
    // base threads through to push-branch's own guard — this is the rev-list call it makes.
    expect(calls[1]).toStrictEqual(["git", "rev-list", "--count", `${INPUT.base}..HEAD`])
    expect(calls[2]).toStrictEqual(["git", "push", "-u", "origin", "feat/gh-168"])
    expect(calls[3]![0]).toBe("gh")
  })

  test("title arrives as a plain input field and reaches `gh pr create --title` verbatim, formatted by nothing here", () => {
    const { calls, service } = scriptedShell([
      ok(),
      ok("1\n"),
      ok(),
      ok("[]\n"),
      ok("https://github.com/o/r/pull/1\n")
    ])
    runWith(publish.run(INPUT), service)

    const create = calls.find((call) => call.includes("create"))
    expect(create).toBeDefined()
    expect(create![create!.indexOf("--title") + 1]).toBe(INPUT.title)
  })

  test("body arrives as a plain input field and reaches `gh pr create --body` verbatim, formatted by nothing here", () => {
    const { calls, service } = scriptedShell([
      ok(),
      ok("1\n"),
      ok(),
      ok("[]\n"),
      ok("https://github.com/o/r/pull/1\n")
    ])
    runWith(publish.run(INPUT), service)

    const create = calls.find((call) => call.includes("create"))
    expect(create).toBeDefined()
    expect(create![create!.indexOf("--body") + 1]).toBe(INPUT.body)
  })

  test("a rejected push short-circuits: PushRejected, and `gh` is never called", () => {
    const { calls, service } = scriptedShell([ok(), ok("1\n"), exit(1, "remote: protected branch\n")])
    const result = runWith(publish.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushRejected)
    expect(calls).toHaveLength(3)
  })
})

/** Reads and parses every row of a journal file at `path`, in order. */
const readRows = (fs: FileSystem.FileSystem, path: string) =>
  Effect.map(fs.readFileString(path), (text) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>))

/** Every journal test runs inside a scoped temp directory standing in for a run root. */
const inTempJournalDir = <A, E>(
  body: (paths: {
    readonly fs: FileSystem.FileSystem
    readonly journalFor: (runId: string) => string
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
): Promise<A> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const journalFor = (runId: string) => path.join(dir, `${runId}.jsonl`)
    return yield* body({ fs, journalFor })
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.runPromise) as Promise<A>

describe("publish — journal", () => {
  test("a green run's journal opens on publish's own start entry and closes on its own end entry, its parts' pairs nested between", async () => {
    const rows = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const { service } = scriptedShell([ok(), ok("1\n"), ok(), ok("[]\n"), ok(`${INPUT.slug}/pull/1\n`)])

        yield* publish.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path, predecessor: Option.none() })),
          Effect.provide(shellLayer(service)),
          Effect.provideService(RunInfo, testRunInfo({ runId: "run-1" }))
        )

        return yield* readRows(fs, path)
      })
    )

    expect(rows.map((row) => [row["node"], row["event"]])).toStrictEqual([
      ["publish", "start"],
      ["push-branch", "start"],
      ["push-branch", "end"],
      ["create-pr", "start"],
      ["create-pr", "end"],
      ["publish", "end"]
    ])
    for (const row of rows) expect(row["runId"]).toBe("run-1")
  })

  test("a resume that recorded publish's success replays it without re-invoking push-branch or create-pr", async () => {
    const result = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        const original = scriptedShell([ok(), ok("1\n"), ok(), ok("[]\n"), ok(`${INPUT.slug}/pull/1\n`)])
        yield* publish.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path: first, predecessor: Option.none() })),
          Effect.provide(shellLayer(original.service)),
          Effect.provideService(RunInfo, testRunInfo({ runId: "run-1" }))
        )

        // A resume is a fresh process: a fresh shell stub with NO replies queued, so any call at all throws.
        const resumed = scriptedShell([])
        const value = yield* publish.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path: second, predecessor: Option.some(first) })),
          Effect.provide(shellLayer(resumed.service)),
          Effect.provideService(RunInfo, testRunInfo({ runId: "run-2" }))
        )

        return { value, calls: resumed.calls, secondRows: yield* readRows(fs, second) }
      })
    )

    expect(result.value).toStrictEqual({ url: `${INPUT.slug}/pull/1` })
    expect(result.calls).toHaveLength(0)
    // The replay short-circuits before publish's own `run` body ever calls push-branch/create-pr,
    // so only publish's own start/end pair lands (a replay still writes both entries).
    expect(result.secondRows).toHaveLength(2)
    expect(result.secondRows[0]).toMatchObject({ node: "publish", event: "start" })
    expect(result.secondRows[1]).toMatchObject({ node: "publish", event: "end", replayed: true, outcome: "ok" })
  })
})
