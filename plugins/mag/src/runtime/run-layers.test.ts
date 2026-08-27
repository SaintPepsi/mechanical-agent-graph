import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, FileSystem, Result, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { Journal } from "mag/runtime/journal/service"
import { platform } from "mag/runtime/platform"
import { RESUME_NODE, RESUME_RULE, ResumeWithoutPredecessor } from "mag/runtime/resume"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { PIPELINE_ROOT } from "mag/runtime/run-info-layer"
import {
  RecordsTempDirFailed,
  RepoRootUnavailable,
  RepositoryIdentityUnavailable,
  type RootEnv,
  RunRootEnv,
  runScopedLayers,
  RunScoped,
  UnsafePathSegment
} from "mag/runtime/run-layers"
import { journalPathFor, ticketDirFor } from "mag/runtime/run-root"
import { RunId } from "mag/runtime/trace/layer"
import { type CommandNotExecutable, type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused. */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const RUN_ID = "20260818142233-a1b2"
const REPO_ROOT = "/repo/top"

const TARGET_HEAD: ShellResult = { exitCode: 0, stdout: "abc123\n", stderr: "" }

/** The default answer to `--git-common-dir`, shared by both sides so `sameRepository` is `true` unless a test says otherwise. */
const COMMON_DIR: ShellResult = { exitCode: 0, stdout: "/repo/top/.git\n", stderr: "" }

/**
 * Answers the git questions the wiring asks; anything else is a test bug. `git rev-parse
 * HEAD` is asked twice per run, at two different `cwd`s (`REPO_ROOT` for `sha`, `PIPELINE_ROOT` for
 * `pipelineSha`) — routed by `cwd`, not by argv alone, since the two reads share the same argv text.
 * `--git-common-dir` is asked twice the same way, once per side of the identity check; a
 * fixture that wants `sameRepository` false gives `homeCommonDir` a different answer than `commonDir`.
 */
const gitShell = (
  toplevel: ShellResult = { exitCode: 0, stdout: `${REPO_ROOT}\n`, stderr: "" },
  pipelineHead: ShellResult = { exitCode: 0, stdout: "pip9876\n", stderr: "" },
  commonDir: ShellResult = COMMON_DIR,
  homeCommonDir: ShellResult = commonDir
): ShellService => ({
  run: (argv, options) => {
    if (argv.includes("--git-common-dir")) {
      return Effect.succeed(options?.cwd === PIPELINE_ROOT ? homeCommonDir : commonDir)
    }
    if (argv.includes("--show-toplevel")) return Effect.succeed(toplevel)
    if (argv.includes("HEAD")) return Effect.succeed(options?.cwd === PIPELINE_ROOT ? pipelineHead : TARGET_HEAD)
    throw new Error(`gitShell: unexpected argv ${argv.join(" ")}`)
  }
})

/**
 * A run's layers, built and then interrogated by running `body` under them. `Effect.scoped` wraps
 * layer build and `body` together, `graph()`'s own shape (`runtime/graph.ts`): `runScopedLayers`'
 * foreign-run-root branch mints its records directory with `fs.makeTempDirectoryScoped`, so this is
 * the scope its finalizer hangs off, closing (and removing the directory) once `body` finishes,
 * success or failure alike — never before.
 */
const runInScope = <A, E>(
  scope: {
    readonly ticket: string
    readonly graph: string
    readonly worktree: boolean
    readonly resume: boolean
    readonly records?: "run-root" | "committed"
  },
  root: RootEnv,
  shell: ShellService,
  runId: string,
  body: Effect.Effect<A, E, never>
) =>
  Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const layers = yield* runScopedLayers(scope)
          return yield* body.pipe(Effect.provide(layers))
        })
      ).pipe(
        Effect.provideService(RunRootEnv, root),
        Effect.provideService(RunId, runId),
        Effect.provide(shellLayer(shell))
      )
    )
  )

/**
 * What did RunInfo resolve to, and does the run dir exist? `RunScope.worktree` is required,
 * no absent-means-primary path — `worktree` defaults to `false` here purely as a local test
 * convenience (most fixtures don't care), never as a stand-in for a type-level default. `resume`
 * gets the same treatment, defaulting `false` (a cold run).
 */
const buildAndInspect = (
  ticket: string,
  root: RootEnv,
  shell: ShellService,
  runId: string = RUN_ID,
  worktree: boolean = false,
  resume: boolean = false,
  records?: "run-root" | "committed"
) =>
  runInScope(
    { ticket, graph: "develop-graph", worktree, resume, ...(records === undefined ? {} : { records }) },
    root,
    shell,
    runId,
    Effect.gen(function* () {
      yield* Journal // forces the journal layer (and its directory creation) to build
      return yield* RunInfo
    })
  )

class TestNodeFailed extends Data.TaggedError("TEST_NODE_FAILED")<{}> {}

/**
 * A leaf that counts its real runs, so "replayed" is proved by the body not executing —
 * `journal/service.test.ts`'s own idiom. Handed a failure, it is the leaf with no success to ever
 * record: the node a resumed run must run live, every time.
 */
const countingNode = (
  name: string,
  result: Effect.Effect<{ readonly ok: boolean }, TestNodeFailed> = Effect.succeed({ ok: true })
) => {
  let calls = 0
  const node = make({
    name,
    description: "Test node.",
    input: Schema.Struct({}),
    success: Schema.Struct({ ok: Schema.Boolean }),
    run: () => {
      calls += 1
      return result
    }
  })
  return { node, calls: () => calls }
}

/** A foreign target's answers — the two common dirs differ, so `sameRepository` is `false`. */
const foreignShell = (): ShellService => gitShell(undefined, undefined, COMMON_DIR, { exitCode: 0, stdout: "/home/pipeline/.git\n", stderr: "" })

const tempRoot = (): { root: RootEnv; cleanup: () => Promise<void> } => {
  const temp = mkdtempSync(join(tmpdir(), "graph-run-layers-"))
  return {
    root: { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" },
    cleanup: () => removeDir(temp)
  }
}

describe("runScopedLayers", () => {
  test("the provided run id reaches RunInfo, and the run directory is created where run-root says", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-98", root, gitShell())

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.runId).toBe(RUN_ID)
      expect(info.ticket).toBe("GH-98")
      expect(info.graph).toBe("develop-graph")
      expect(info.repoRoot).toBe(REPO_ROOT)
      expect(info.sha).toBe("abc123")
      expect(info.pipelineSha).toBe("pip9876")

      const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket: "GH-98", runId: RUN_ID })
      expect(existsSync(dirname(path))).toBe(true)
      // RunInfo carries the same run directory the journal writes into, so a node can place
      // an artifact there without recomputing the path.
      expect(info.runRoot).toBe(dirname(path))
    } finally {
      await cleanup()
    }
  })

  test("a ticket id with a separator fails before any file is written", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-98/../../etc", root, gitShell())

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(UnsafePathSegment)
      expect((result.failure as UnsafePathSegment).field).toBe("ticket")
      expect((result.failure as UnsafePathSegment).value).toBe("GH-98/../../etc")
      expect(existsSync(join(root.env["CLAUDE_CONFIG_DIR"]!, "graph"))).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("an unsafe run id is rejected the same way", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-98", root, gitShell(), "../oops")

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(UnsafePathSegment)
      expect((result.failure as UnsafePathSegment).field).toBe("runId")
    } finally {
      await cleanup()
    }
  })

  test("no repo root, no run: git's own words come back in the failure", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect(
        "GH-98",
        root,
        gitShell({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RepoRootUnavailable)
      expect((result.failure as RepoRootUnavailable).detail).toBe("fatal: not a git repository")
    } finally {
      await cleanup()
    }
  })

  test("worktree: false leaves workRoot equal to repoRoot", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-98", root, gitShell(), RUN_ID, false)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.workRoot).toBe(info.repoRoot)
    } finally {
      await cleanup()
    }
  })

  test("worktree: true composes workRoot beside the checkout, while repoRoot and runRoot stay the primary checkout's own values", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-173", root, gitShell(), RUN_ID, true)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.repoRoot).toBe(REPO_ROOT)
      expect(info.workRoot).toBe(`${REPO_ROOT}-worktrees/GH-173-${RUN_ID}`)
      expect(info.runRoot).not.toContain("-worktrees")
    } finally {
      await cleanup()
    }
  })

  test("RunScoped already set returns Layer.empty — no shell call, no RunInfo override", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const throwingShell: ShellService = {
        run: (argv) => {
          throw new Error(`shell should not run when RunScoped is already set: ${argv.join(" ")}`)
        }
      }
      const result = await Effect.runPromise(
        Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const layers = yield* runScopedLayers({
                ticket: "GH-286",
                graph: "fixture-subgraph",
                worktree: false,
                resume: false
              })
              return yield* RunInfo.pipe(Effect.provide(layers))
            })
          ).pipe(
            Effect.provideService(RunRootEnv, root),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunScoped, true),
            Effect.provide(shellLayer(throwingShell))
          )
        )
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      // The default RunInfo, untouched — Layer.empty provided nothing, so the composed graph's own
      // scope (ticket "GH-286") never reached RunInfo; the host's own ambient value stays in place.
      expect(result.success.ticket).toBe("")
      expect(existsSync(join(root.env["CLAUDE_CONFIG_DIR"]!, "graph"))).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("sha and pipelineSha resolve from two different checkouts, each read once", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const calls: Array<{ readonly argv: readonly string[]; readonly cwd: string | undefined }> = []
      const shell: ShellService = {
        run: (argv, options) => {
          calls.push({ argv, cwd: options?.cwd })
          return gitShell().run(argv, options)
        }
      }
      const result = await buildAndInspect("GH-98", root, shell)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.sha).toBe("abc123")
      expect(info.pipelineSha).toBe("pip9876")

      // Resolved once per run: exactly one HEAD read at each checkout, not one per row.
      const headCalls = calls.filter((c) => c.argv.includes("HEAD"))
      expect(headCalls).toHaveLength(2)
      expect(headCalls.filter((c) => c.cwd === REPO_ROOT)).toHaveLength(1)
      expect(headCalls.filter((c) => c.cwd === PIPELINE_ROOT)).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  test("no git at the plugin checkout labels pipelineSha blank, the run proceeds", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect(
        "GH-98",
        root,
        gitShell(undefined, { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" })
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.sha).toBe("abc123")
      expect(info.pipelineSha).toBe("")
    } finally {
      await cleanup()
    }
  })

  describe("resume", () => {
    test("a resumed run replays completed nodes and continues live from the first without a recorded success", async () => {
      const { root, cleanup } = tempRoot()
      try {
        const ticket = "GH-269-ac01"
        const scope = { ticket, graph: "develop-graph", worktree: false }
        const a = countingNode("node-a")
        const b = countingNode("node-b")
        const boom = countingNode("node-boom", Effect.fail(new TestNodeFailed()))
        const body = Effect.gen(function* () {
          yield* a.node.run({})
          yield* b.node.run({})
          yield* boom.node.run({})
        })

        // First run: two nodes succeed, the third always fails — the journal records exactly that.
        const first = await runInScope({ ...scope, resume: false }, root, gitShell(), "20260820000000-a1a1", body)
        expect(Result.isFailure(first)).toBe(true)
        expect(a.calls()).toBe(1)
        expect(b.calls()).toBe(1)
        expect(boom.calls()).toBe(1)

        // Second run, resumed: node-a/node-b replay from the predecessor's journal (their counters
        // stay put), node-boom — the first node with no recorded success — runs live again.
        const second = await runInScope({ ...scope, resume: true }, root, gitShell(), "20260820010000-b2b2", body)
        expect(Result.isFailure(second)).toBe(true)
        expect(a.calls()).toBe(1)
        expect(b.calls()).toBe(1)
        expect(boom.calls()).toBe(2)
      } finally {
        await cleanup()
      }
    })

    test("the resumed run's own journal opens with the resume-run start/end pair, carrying the predecessor and the rule", async () => {
      const { root, cleanup } = tempRoot()
      try {
        const ticket = "GH-269-ac02"
        const scope = { ticket, graph: "develop-graph", worktree: false }
        const a = countingNode("node-a")
        const firstRunId = "20260820000000-c3c3"
        const secondRunId = "20260820010000-d4d4"

        const first = await runInScope({ ...scope, resume: false }, root, gitShell(), firstRunId, a.node.run({}))
        expect(Result.isSuccess(first)).toBe(true)

        const second = await runInScope({ ...scope, resume: true }, root, gitShell(), secondRunId, Effect.void)
        expect(Result.isSuccess(second)).toBe(true)

        const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket, runId: secondRunId })
        const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        expect(lines).toHaveLength(2)
        expect(lines[0]).toMatchObject({ node: RESUME_NODE, event: "start" })
        expect(lines[1]).toMatchObject({
          node: RESUME_NODE,
          event: "end",
          outcome: "ok",
          success: { predecessorRunId: firstRunId, rule: RESUME_RULE, replayable: 1 }
        })
      } finally {
        await cleanup()
      }
    })

    test("work root: a resumed run adopts its predecessor's tree, and resuming that resume adopts the same tree", async () => {
      const { root, cleanup } = tempRoot()
      try {
        const ticket = "GH-269-workroot"
        const scope = { ticket, graph: "develop-graph", worktree: true }
        const run1 = "20260820000000-e5e5"
        const run2 = "20260820010000-f6f6"
        const run3 = "20260820020000-a7a7"

        const first = await runInScope({ ...scope, resume: false }, root, gitShell(), run1, countingNode("node-a").node.run({}))
        expect(Result.isSuccess(first)).toBe(true)
        const firstWorkRoot = `${REPO_ROOT}-worktrees/${ticket}-${run1}`

        // run2 must run a real node of its own (node-a replays from run1 rather than re-executing).
        // With no node at all, run2's journal would hold only its `resume-run` record, a row
        // `mostReplayable` (resume.ts) excludes from the count — run3 would then fall back to run1
        // and never exercise `workRootOf`'s `Some` branch.
        const secondInfo = await runInScope(
          { ...scope, resume: true },
          root,
          gitShell(),
          run2,
          Effect.gen(function* () {
            yield* countingNode("node-a").node.run({})
            return yield* RunInfo
          })
        )
        expect(Result.isSuccess(secondInfo)).toBe(true)
        if (!Result.isSuccess(secondInfo)) return
        // Adopted from run1's own record: NOT `${REPO_ROOT}-worktrees/${ticket}-${run2}`, the path a
        // cold run of this scope would have used.
        expect((secondInfo.success as RunInfoService).workRoot).toBe(firstWorkRoot)

        const thirdInfo = await buildAndInspect(ticket, root, gitShell(), run3, true, true)
        expect(Result.isSuccess(thirdInfo)).toBe(true)
        if (!Result.isSuccess(thirdInfo)) return
        // run1 and run2 both replay one distinct node (node-a), a tie `mostReplayable` breaks by
        // newest run id — run2 wins, so run3 resumes run2, which recorded run1's tree as ITS OWN work
        // root (`resume.ts`'s `workRootOf`) — the chain converges on one tree rather than drifting to
        // run2's run id. If `workRootOf` returned `Option.none()` unconditionally, this would read
        // `${REPO_ROOT}-worktrees/${ticket}-${run2}` instead.
        expect((thirdInfo.success as RunInfoService).workRoot).toBe(firstWorkRoot)
      } finally {
        await cleanup()
      }
    })

    test("a refused resume leaves no run directory behind", async () => {
      const { root, cleanup } = tempRoot()
      try {
        const ticket = "GH-269-refused"
        const result = await buildAndInspect(ticket, root, gitShell(), RUN_ID, false, true)

        expect(Result.isFailure(result)).toBe(true)
        if (!Result.isFailure(result)) return
        expect(result.failure).toBeInstanceOf(ResumeWithoutPredecessor)
        expect((result.failure as ResumeWithoutPredecessor).inspected).toBe(0)
        const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket, runId: RUN_ID })
        expect(existsSync(dirname(path))).toBe(false)
        expect(existsSync(ticketDirFor({ ...root, repoPath: REPO_ROOT, ticket }))).toBe(false)
      } finally {
        await cleanup()
      }
    })

    test("a cold run passes Option.none() as its predecessor: no resume-run row, and nothing replays, despite a perfectly good sibling on disk", async () => {
      const { root, cleanup } = tempRoot()
      try {
        const ticket = "GH-269-cold"
        const scope = { ticket, graph: "develop-graph", worktree: false }
        const run1 = "20260820000000-b8b8"
        const run2 = "20260820010000-c9c9"

        const first = await runInScope({ ...scope, resume: false }, root, gitShell(), run1, countingNode("node-a").node.run({}))
        expect(Result.isSuccess(first)).toBe(true)

        const b = countingNode("node-a")
        const second = await runInScope({ ...scope, resume: false }, root, gitShell(), run2, b.node.run({}))
        expect(Result.isSuccess(second)).toBe(true)
        expect(b.calls()).toBe(1) // ran live: a cold run never replays, sibling or not

        const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket, runId: run2 })
        const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        expect(lines.some((line) => line.node === RESUME_NODE)).toBe(false)
        expect(lines.find((line) => line.event === "end")).toMatchObject({ replayed: false })
      } finally {
        await cleanup()
      }
    })
  })

  test("matching common dirs keep recordsRoot the same string as workRoot", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await buildAndInspect("GH-98", root, gitShell())

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.recordsRoot).toBe(info.workRoot)
    } finally {
      await cleanup()
    }
  })

  // A foreign run's committed record commits on the target's own current branch — CLAUDE.md's own
  // "committed to the branch" line — so `recordsRoot` equals `workRoot`, exactly the same-repository
  // shape, no second tree ever materialized.
  test("differing common dirs, under records: \"committed\", route recordsRoot to workRoot — the same tree, nothing else", async () => {
    const { root, cleanup } = tempRoot()
    try {
      // `gitShell` throws on any argv it does not expect, so a stray `git worktree add` or
      // `git checkout -b` fails the build outright rather than passing unnoticed.
      const result = await buildAndInspect("GH-98", root, foreignShell(), RUN_ID, false, false, "committed")

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const info = result.success as RunInfoService
      expect(info.recordsRoot).toBe(info.workRoot)
    } finally {
      await cleanup()
    }
  })

  // Under the default `run-root` policy nothing ever commits into a foreign run's records root, so
  // it mints a disposable OS temp directory instead — `stage-shipped-graph/stage.ts`'s own
  // `fs.makeTempDirectory` idiom — the one case left where `recordsRoot` still differs from `workRoot`.
  test("differing common dirs, under the default run-root policy, route recordsRoot to a fresh OS temp directory", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const result = await runInScope(
        { ticket: "GH-98", graph: "develop-graph", worktree: false, resume: false },
        root,
        foreignShell(),
        RUN_ID,
        Effect.gen(function* () {
          yield* Journal
          const info = yield* RunInfo
          // Checked from inside the scope: the directory must exist while the run is still using
          // it, before `Effect.scoped` (`runInScope`'s own doc comment) has any chance to close it.
          return { info, existedDuringRun: existsSync(info.recordsRoot) }
        })
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const { info, existedDuringRun } = result.success as { info: RunInfoService; existedDuringRun: boolean }
      expect(info.recordsRoot).not.toBe(info.workRoot)
      expect(existedDuringRun).toBe(true)
      // The scope closed once the run's own effect finished — `fs.makeTempDirectoryScoped`'s own
      // finalizer already removed the directory, no leftover cleanup needed here.
      expect(existsSync(info.recordsRoot)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("a foreign run-root run whose graph fails still leaves no records- temp dir behind", async () => {
    const { root, cleanup } = tempRoot()
    try {
      let recordsRoot: string | undefined
      const result = await runInScope(
        { ticket: "GH-98", graph: "develop-graph", worktree: false, resume: false },
        root,
        foreignShell(),
        RUN_ID,
        Effect.gen(function* () {
          const info = yield* RunInfo
          recordsRoot = info.recordsRoot
          // Stands in for a node failing partway through the pipeline: the scope must still close,
          // and its finalizer must still run, on a failed exit as much as a successful one.
          return yield* Effect.fail(new TestNodeFailed())
        })
      )

      expect(Result.isFailure(result)).toBe(true)
      expect(recordsRoot).toBeDefined()
      if (recordsRoot !== undefined) expect(existsSync(recordsRoot)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("a home run makes no extra git call for its records placement at all", async () => {
    const { root, cleanup } = tempRoot()
    try {
      // `gitShell` throws on any argv it does not expect, so a stray git call fails the build
      // outright rather than passing unnoticed.
      const result = await buildAndInspect("GH-98", root, gitShell())
      expect(Result.isSuccess(result)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("no common dir at this pipeline's own checkout fails the run before any record can be placed", async () => {
    const { root, cleanup } = tempRoot()
    try {
      const noHomeCommonDir: ShellResult = { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }
      const result = await buildAndInspect("GH-98", root, gitShell(undefined, undefined, COMMON_DIR, noHomeCommonDir))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RepositoryIdentityUnavailable)
      expect((result.failure as RepositoryIdentityUnavailable).detail).toBe("fatal: not a git repository")
    } finally {
      await cleanup()
    }
  })
})

// Compile-time pin on `runScopedLayers`' declared error union ("the
// exported selection's error channel and `runScopedLayers`' widened union each carry a compile-time
// assertion" — PRINCIPLES.md, "An exported `runtime/` type ships with a compile-time pin on what
// it promises"; `construct.test.ts`'s `.finalise` pin is the precedent). Checked
// both directions, so the union can neither drop a tag (e.g. `readSiblingRows` leaking a raw
// `PlatformError`) nor gain one silently: `bun run typecheck && bun run test` both stay green
// otherwise, since nothing at runtime observes `E`.
//
// `CommandNotExecutable` belongs in the declared union too: `resolveRepoRoot`'s
// `git rev-parse --show-toplevel` has always been able to fail that way and nothing here catches
// it; this pin is what first surfaced that omission. `RecordsTempDirFailed` is
// `fs.makeTempDirectoryScoped`'s own failure mode, reachable only under a foreign run's default
// `records: "run-root"` policy (`recordsRootFor`).
type RunScopedLayersError = ReturnType<typeof runScopedLayers> extends Effect.Effect<any, infer E, any> ? E : never
type Extends<A, B> = [A] extends [B] ? true : false
type DeclaredRunScopedLayersError =
  | UnsafePathSegment
  | RepoRootUnavailable
  | ResumeWithoutPredecessor
  | CommandNotExecutable
  | RepositoryIdentityUnavailable
  | RecordsTempDirFailed
const _errorChannelCoversDeclared: Extends<RunScopedLayersError, DeclaredRunScopedLayersError> = true
const _declaredCoversErrorChannel: Extends<DeclaredRunScopedLayersError, RunScopedLayersError> = true

describe("runScopedLayers — compile-time pin on its declared error channel", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_errorChannelCoversDeclared).toBe(true)
    expect(_declaredCoversErrorChannel).toBe(true)
  })
})
