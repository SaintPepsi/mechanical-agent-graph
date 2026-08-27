import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Result, Schema } from "effect"
import { liveClaudeAgent } from "mag/runtime/claude/agent"
import type { TransportError } from "mag/runtime/claude/errors"
import { liveChildCount } from "mag/runtime/claude/reaper"
import {
  ClaudeBin,
  claudeIsolationLayer,
  claudeTimingLayer,
  type ClaudePrint,
  type ClaudeReply,
  Heartbeat,
  type HeartbeatService
} from "mag/runtime/claude/service"
import type { SpawnTiming } from "mag/runtime/claude/spawn"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"

/**
 * The transport against real processes. Each fixture under `test/fixtures/claude/` is a POSIX shell
 * script standing in for `claude -p`: it emits the same `stream-json` lines on stdout, the same
 * stderr, and the same exit codes, which is everything this transport reads. `ClaudeBin` is the
 * seam that points the spawn at one.
 *
 * The watchdog's own tick and grace are injected through `claudeTimingLayer`, so a bounds test costs
 * milliseconds rather than a five-second poll plus a five-second SIGTERM grace. The bounds under
 * test are still the real ones; only the clock the watchdog runs on shrinks.
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "claude")
const fixture = (name: string): string => join(FIXTURES, name)

/**
 * A fresh `tmpdir()` directory a fixture can write into as its own `cwd`, cleaned up by the
 * caller's `finally`. `FIXTURE_ARGVFILE`/`FIXTURE_COUNTFILE`/`FIXTURE_PIDFILE` are gone from the
 * composed environment along with everything else the manifest does not name, so a fixture takes
 * its scratch path the way every other spawn input arrives, as `cwd`. `entry` is the one file the fixture writes into it, unlinked before the now-
 * empty directory itself is, so cleanup never reaches for a recursive delete. A short-circuited
 * call never writes it, hence the tolerated unlink failure.
 */
const scratchDir = (
  prefix: string,
  entry: string
): { readonly dir: string; readonly file: string; readonly cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const file = join(dir, entry)
  return {
    dir,
    file,
    cleanup: () => {
      try {
        unlinkSync(file)
      } catch {
        // Absent is fine, see above.
      }
      rmdirSync(dir)
    }
  }
}

interface Beat {
  readonly sessionId: string
  readonly beatEpochSecs: number
}

const recorder = (into: Array<Beat>): HeartbeatService => ({
  beat: (sessionId, beatEpochSecs) => Effect.sync(() => void into.push({ sessionId, beatEpochSecs }))
})

/** A watchdog tick and SIGTERM grace short enough that a one-second bound resolves in one. */
const QUICK: Partial<SpawnTiming> = { pollMs: 50, termGraceMs: 200 }

/**
 * Polls until `pid` is truly gone rather than checking liveness at one instant. `kill(pid, 0)`
 * succeeds on a zombie, not just a live process: a grandchild that outlives its own parent
 * reparents to init when the group SIGKILL takes its parent, and until init reaps it, its pid
 * still answers `kill(pid, 0)`. That window is sub-millisecond locally but long enough to lose a
 * single-instant check on a loaded CI runner, observed to flake in practice.
 * Resolves once the probe throws or the deadline passes, whichever comes first: a survivor past
 * the deadline still fails the caller's own `toThrow()` assertion, so this only relaxes the
 * timing, never the requirement that the process actually dies.
 */
const awaitReaped = async (pid: number, deadlineMs = 5_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(30)
  }
}

const run = <A>(
  script: string,
  request: ClaudePrint<A>,
  beats: Array<Beat> = [],
  timing: Partial<SpawnTiming> = {},
  extra: Layer.Layer<never> = Layer.empty
): Promise<Result.Result<ClaudeReply<A>, TransportError>> =>
  Effect.runPromise(
    Effect.result(
      liveClaudeAgent.prompt(request).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClaudeBin, fixture(script)),
          Layer.succeed(Heartbeat, recorder(beats)),
          claudeTimingLayer(timing),
          extra
        ))
      )
    )
  )

const success = <A>(result: Result.Result<ClaudeReply<A>, TransportError>): ClaudeReply<A> => {
  if (!Result.isSuccess(result)) throw new Error(`expected a success, got ${JSON.stringify(result)}`)
  return result.success
}

const failure = <A>(result: Result.Result<ClaudeReply<A>, TransportError>): TransportError => {
  if (Result.isSuccess(result)) throw new Error(`expected a failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

const Verdict = Schema.Struct({ status: Schema.Literals(["pass", "fail"]) })
const VERDICT = verdictSchema(Verdict)

afterEach(() => {
  // Every call reaps its own child, so the registry is empty again between tests. A leak here would
  // mean the process-level handlers stay attached for the rest of the suite.
  expect(liveChildCount()).toBe(0)
})

describe("the fixtures themselves", () => {
  test("every fixture is committed with the executable bit", async () => {
    // The maintainer's checkout sits on a Windows mount, where `core.fileMode` is false and the
    // filesystem reports 755 for everything — so the filesystem cannot answer this. Git's index is
    // what CI checks out, and a fixture committed 644 there fails every spawn below as
    // `not-executable` on ubuntu-latest while passing locally. This asks the index.
    const proc = Bun.spawn(["git", "ls-files", "-s", "--", FIXTURES], {
      cwd: join(import.meta.dir, "..", "..", "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe"
    })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exitCode).toBe(0)

    const entries = stdout.split("\n").filter((line) => line !== "")
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.startsWith("100755 ")).toBe(true)
    }
  })
})

describe("a schema'd call", () => {
  test("returns the decoded structured_output, the cost, and the sessions it touched", async () => {
    const reply = success(await run("ok.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(reply.verdict).toEqual({ status: "pass" })
    expect(reply.costUsd).toBe(0.25)
    expect(reply.attempts).toBe(1)
    expect(reply.sessions).toContain("sess-ok")
  })

  test("fails as CLAUDE_NULL_VERDICT when structured_output does not match the schema", async () => {
    const error = failure(await run("prose.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(error._tag).toBe("CLAUDE_NULL_VERDICT")
    if (error._tag !== "CLAUDE_NULL_VERDICT") return
    expect(error.reason).toBe("decode-mismatch")
    expect(error.sessionId).toBe("sess-prose")
  })

  test("fails as CLAUDE_NULL_VERDICT on error_max_structured_output_retries, after one spawn", async () => {
    const error = failure(await run("retries-exhausted.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(error._tag).toBe("CLAUDE_NULL_VERDICT")
    if (error._tag !== "CLAUDE_NULL_VERDICT") return
    expect(error.reason).toBe("error_max_structured_output_retries")
    expect(error.attempts).toBe(1)
    expect(error.snippet).toContain("could not satisfy the schema")
  })

  test("puts the draft-07 document on --json-schema and the pinned session on --session-id", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    try {
      const reply = success(
        await run("echo-argv.sh", {
          prompt: "the brief",
          jsonSchema: verdictSchema(Schema.Struct({})),
          model: "haiku",
          cwd: scratch.dir
        })
      )
      const argv = (await Bun.file(scratch.file).text()).split("\n").filter((line) => line !== "")
      expect(argv[0]).toBe("-p")
      expect(argv[1]).toBe("the brief")
      expect(argv).toContain("--output-format")
      expect(argv).toContain("stream-json")
      expect(argv).toContain("--verbose")
      expect(argv[argv.indexOf("--model") + 1]).toBe("haiku")
      expect(argv[argv.indexOf("--json-schema") + 1]).toContain("http://json-schema.org/draft-07/schema#")
      expect(argv[argv.indexOf("--session-id") + 1]).toBe(reply.sessions[0])
      expect(argv).not.toContain("--resume")
      // A request with no agent sends no --agent, so a caller that never opts into an agent gets a
      // byte-for-byte unchanged dispatch.
      expect(argv).not.toContain("--agent")
    } finally {
      scratch.cleanup()
    }
  })

  test("the request's agent becomes --agent on the argv", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    try {
      success(await run("echo-argv.sh", { prompt: "the brief", agent: "effect-expert", cwd: scratch.dir }))
      const argv = (await Bun.file(scratch.file).text()).split("\n").filter((line) => line !== "")
      expect(argv[argv.indexOf("--agent") + 1]).toBe("effect-expert")
    } finally {
      scratch.cleanup()
    }
  })

  test("isolation on puts --setting-sources project --strict-mcp-config on the argv", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    try {
      success(await run("echo-argv.sh", { prompt: "the brief", cwd: scratch.dir }, [], {}, claudeIsolationLayer(true)))
      const argv = (await Bun.file(scratch.file).text()).split("\n").filter((line) => line !== "")
      expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project")
      expect(argv).toContain("--strict-mcp-config")
    } finally {
      scratch.cleanup()
    }
  })

  // The layer is explicit, never the ambient default: this suite runs inside graph runs, and an
  // isolated run exports GRAPH_ISOLATE_CONFIG=1 to its children — resolving the default here would
  // make the assertion depend on the invoking run's own isolation setting, turning this very test
  // red whenever the feature's own switch is on. The default's env wiring is tested in
  // service.test.ts with a fresh process per case.
  test("isolation off puts neither flag on the argv", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    try {
      success(await run("echo-argv.sh", { prompt: "the brief", cwd: scratch.dir }, [], {}, claudeIsolationLayer(false)))
      const argv = (await Bun.file(scratch.file).text()).split("\n").filter((line) => line !== "")
      expect(argv).not.toContain("--setting-sources")
      expect(argv).not.toContain("--strict-mcp-config")
    } finally {
      scratch.cleanup()
    }
  })
})

describe("cwd", () => {
  test("runs the child inside the requested directory", async () => {
    const reply = success(
      await run("cwd-report.sh", {
        prompt: "anything",
        jsonSchema: verdictSchema(Schema.Struct({ cwd: Schema.String })),
        cwd: FIXTURES
      })
    )
    expect(reply.verdict.cwd).toBe(FIXTURES)
  })
})

describe("a schemaless call", () => {
  test("digs the object out of prose and fences", async () => {
    const reply = success(await run("prose.sh", { prompt: "anything" }))
    expect(reply.verdict).toEqual({ status: "pass" })
    expect(reply.attempts).toBe(1)
  })

  test("nudges once on an unparseable reply and returns what the resume produced", async () => {
    const reply = success(await run("nudgeable.sh", { prompt: "anything" }))
    expect(reply.verdict).toEqual({ status: "pass" })
    expect(reply.attempts).toBe(2)
    // Both spawns' costs land on the reply: 1 for the unparseable turn, 0.25 for the nudge.
    expect(reply.costUsd).toBe(1.25)
  })

  test("fails as CLAUDE_NULL_VERDICT with attempts 2 when the nudge is unparseable too", async () => {
    const error = failure(await run("stubborn.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_NULL_VERDICT")
    if (error._tag !== "CLAUDE_NULL_VERDICT") return
    expect(error.reason).toBe("unparseable")
    expect(error.attempts).toBe(2)
  })
})

describe("a spawn that fails", () => {
  test("takes one corrective resume, and its answer becomes the reply", async () => {
    const reply = success(await run("corrective.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(reply.verdict).toEqual({ status: "pass" })
    // Two spawns: the one that exited 1, and the resume that answered. `attempts` counts spawns
    // the call made, so a spawn that failed still counts.
    expect(reply.attempts).toBe(2)
  })

  test("surfaces the original failure when the corrective resume fails too", async () => {
    const error = failure(await run("exit1.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(error._tag).toBe("CLAUDE_AGENT_EXIT")
    if (error._tag !== "CLAUDE_AGENT_EXIT") return
    expect(error.reason).toBe("nonzero-exit")
    expect(error.exitCode).toBe(1)
    expect(error.stderrTail).toContain("something went wrong")
  })

  test("reports a missing binary as CLAUDE_AGENT_EXIT not-executable", async () => {
    const error = failure(await run("does-not-exist.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_AGENT_EXIT")
    if (error._tag !== "CLAUDE_AGENT_EXIT") return
    expect(error.reason).toBe("not-executable")
    expect(error.exitCode).toBeNull()
  })

  test("reports an exit-0 run that said nothing as CLAUDE_AGENT_EXIT no-result-message", async () => {
    const error = failure(await run("empty.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_AGENT_EXIT")
    if (error._tag !== "CLAUDE_AGENT_EXIT") return
    expect(error.reason).toBe("no-result-message")
  })

  test("reports a result message of the wrong shape as CLAUDE_AGENT_EXIT undecodable-result", async () => {
    const error = failure(await run("garbage-result.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_AGENT_EXIT")
    if (error._tag !== "CLAUDE_AGENT_EXIT") return
    expect(error.reason).toBe("undecodable-result")
  })

  test("reports a signal death with a null exitCode, as the tag documents", async () => {
    const error = failure(await run("self-kill.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_AGENT_EXIT")
    if (error._tag !== "CLAUDE_AGENT_EXIT") return
    expect(error.reason).toBe("signal")
    expect(error.signal).toBe("SIGKILL")
    // `child.exited` reports 128+signal here; the contract is null, and consumers written to test
    // `exitCode === null` for a signal death depend on it.
    expect(error.exitCode).toBeNull()
  })

  /**
   * The other side of the two-resume bound: the corrective resume answered, but with prose. A nudge
   * here would be the second resume of a call that already spent one, so the call stops at two
   * spawns and reports what it has.
   */
  test("does not nudge after a corrective resume, so the call stops at two spawns", async () => {
    const error = failure(await run("corrective-then-prose.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_NULL_VERDICT")
    if (error._tag !== "CLAUDE_NULL_VERDICT") return
    expect(error.reason).toBe("unparseable")
    expect(error.attempts).toBe(2)
    expect(error.snippet).toContain("could not produce a verdict")
  })

  test("routes a nudge that itself fails into the corrective resume, three spawns in all", async () => {
    const reply = success(await run("nudge-then-fail.sh", { prompt: "anything" }))
    expect(reply.verdict).toEqual({ status: "pass" })
    expect(reply.attempts).toBe(3)
    // 1 for the unparseable first reply, 0.25 for the corrective that answered. The failing nudge
    // in between reports no cost. Asserted because this is the one path where an attempt reaches
    // the reply through two consumers, so a double-count would show up here and nowhere else.
    expect(reply.costUsd).toBe(1.25)
    expect(reply.sessions).toEqual([reply.sessions[0], "sess-chain"])
  })
})

describe("a usage limit", () => {
  test("recovers the reset time from the stderr tail", async () => {
    const error = failure(await run("ratelimit.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
    if (error._tag !== "CLAUDE_USAGE_LIMIT") return
    expect(error.source).toBe("stderr")
    expect(error.resetAt).toBe("2026-08-17T22:00:00.000Z")
    expect(error.sessionId).toBe("sess-limit")
  })

  test("derives the reset time from an api_retry event's retry_delay_ms", async () => {
    const before = Date.now()
    const error = failure(await run("retry-then-limit.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
    if (error._tag !== "CLAUDE_USAGE_LIMIT") return
    expect(error.source).toBe("api_retry")
    expect(new Date(error.resetAt).getTime()).toBeGreaterThanOrEqual(before + 60_000)
  })

  /**
   * The exit-0 half of the classification, which lives in `agent.ts` because `api_error_status`
   * only exists where there is a result message to carry it.
   */
  test("reads api_error_status off a result message on a run that exited 0", async () => {
    const error = failure(await run("limit-in-result.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
    if (error._tag !== "CLAUDE_USAGE_LIMIT") return
    expect(error.source).toBe("api_error_status")
    expect(error.sessionId).toBe("sess-status")
  })

  /**
   * A resume reaches the same API under the same account, so a limit that lands on the nudge is the
   * same event as one that lands on the first spawn and has to carry the same tag. Classifying only
   * the first spawn's reply made the tag depend on which spawn the limit happened to hit: a caller
   * keying its wait on `CLAUDE_USAGE_LIMIT` saw `CLAUDE_NULL_VERDICT` instead and re-ran the node
   * straight back into the spent window.
   */
  test("classifies a limit that lands on the nudge, not just on the first spawn", async () => {
    const error = failure(await run("nudge-then-limit.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
    if (error._tag !== "CLAUDE_USAGE_LIMIT") return
    expect(error.source).toBe("api_error_status")
    expect(error.sessionId).toBe("sess-nudge-limit")
    expect(error.resetAt).not.toBe("")
  })

  /**
   * The seam between the two halves: exit 0, no result message. `spawn.ts` classifies it, because
   * `agent.ts` never gets a message to read.
   */
  test("survives an exit-0 run that announced the limit and then said nothing", async () => {
    const error = failure(await run("limit-then-quiet-exit.sh", { prompt: "anything" }))
    expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
    if (error._tag !== "CLAUDE_USAGE_LIMIT") return
    expect(error.source).toBe("api_retry")
    expect(error.resetAt).not.toBe("")
  })

  /**
   * A usage limit holds no finished verdict to re-emit and already carries the `resetAt` the
   * resume would be retrying past, so `corrective` must fail with the original error instead of
   * spending a second spawn. The fixture counts its own invocations, which is what this asserts —
   * the tag alone can't, since `UsageLimit` carries no `attempts` field.
   */
  test("skips the corrective resume, spending exactly one spawn", async () => {
    const scratch = scratchDir("usage-limit-once", "count.txt")
    try {
      const error = failure(await run("usage-limit-once.sh", { prompt: "anything", cwd: scratch.dir }))
      expect(error._tag).toBe("CLAUDE_USAGE_LIMIT")
      const invocations = (await Bun.file(scratch.file).text()).split("\n").filter((line) => line !== "").length
      expect(invocations).toBe(1)
    } finally {
      scratch.cleanup()
    }
  })
})

describe("the watchdog", () => {
  test("fails as CLAUDE_STARTUP_SILENCE when nothing arrives before the startup bound", async () => {
    const error = failure(await run("silent.sh", { prompt: "anything", bounds: { startupSecs: 1 } }, [], QUICK))
    expect(error._tag).toBe("CLAUDE_STARTUP_SILENCE")
    if (error._tag !== "CLAUDE_STARTUP_SILENCE") return
    expect(error.boundSecs).toBe(1)
    expect(error.silentSecs).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test("fails as CLAUDE_IDLE_TIMEOUT bound generating when a started run goes quiet mid-answer", async () => {
    const error = failure(await run("stalls.sh", { prompt: "anything", bounds: { generatingSecs: 1 } }, [], QUICK))
    expect(error._tag).toBe("CLAUDE_IDLE_TIMEOUT")
    if (error._tag !== "CLAUDE_IDLE_TIMEOUT") return
    expect(error.bound).toBe("generating")
    expect(error.sessionId).toBe("sess-stall")
  }, 30_000)

  /**
   * The bound every long tool call in production actually runs under. `message_stop` returns the
   * watcher to WAITING, and nothing else in the suite emits it — so without this fixture the
   * GENERATING→WAITING transition and the 900-second tool bound are both unreachable, and a
   * regression collapsing them onto the 60-second generating bound would kill every real tool run
   * with the suite still green.
   */
  test("applies the tool bound, not the generating bound, once generation has stopped", async () => {
    const error = failure(
      await run("tool-stall.sh", { prompt: "anything", bounds: { toolSecs: 1, generatingSecs: 30 } }, [], QUICK)
    )
    expect(error._tag).toBe("CLAUDE_IDLE_TIMEOUT")
    if (error._tag !== "CLAUDE_IDLE_TIMEOUT") return
    expect(error.bound).toBe("tool")
    expect(error.boundSecs).toBe(1)
    expect(error.sessionId).toBe("sess-tool")
  }, 30_000)

  test("the idle kill reaches the whole process group, so a grandchild is gone too", async () => {
    const scratch = scratchDir("grandchild", "grandchild.pid")
    try {
      const error = failure(
        await run("grandchild.sh", { prompt: "anything", bounds: { generatingSecs: 1 }, cwd: scratch.dir }, [], QUICK)
      )
      expect(error._tag).toBe("CLAUDE_IDLE_TIMEOUT")
      const grandchild = Number((await Bun.file(scratch.file).text()).trim())
      expect(Number.isInteger(grandchild)).toBe(true)
      // The grandchild was started by the fixture, never by this transport, so only the
      // process-group signal could have reached it.
      await awaitReaped(grandchild)
      expect(() => process.kill(grandchild, 0)).toThrow()
    } finally {
      scratch.cleanup()
    }
  }, 30_000)

  /**
   * Exactly one, not at least one. The watchdog's first tick runs immediately rather than after a
   * poll interval, so a `lastBeatAt` starting at zero makes that tick's `now - lastBeatAt >= beatMs`
   * trivially true and writes the same session again milliseconds after this one — three times over
   * a fully-nudged call. Seeding `lastBeatAt` at spawn time is what keeps the stated contract, at
   * most one beat per `beatMs`, true from the first tick rather than from the second.
   */
  test("beats exactly once with the pinned session for a run shorter than the beat interval", async () => {
    const beats: Array<Beat> = []
    const reply = success(await run("ok.sh", { prompt: "anything", jsonSchema: VERDICT }, beats))
    expect(beats.length).toBe(1)
    expect(beats[0]?.sessionId).toBe(reply.sessions[0] ?? "")
  })
})

describe("the pinned session", () => {
  test("is generated when the caller supplies none, and leads the reply's session list", async () => {
    const reply = success(await run("ok.sh", { prompt: "anything", jsonSchema: VERDICT }))
    expect(reply.sessions[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(reply.sessions[1]).toBe("sess-ok")
  })

  test("is the caller's when one is supplied", async () => {
    const reply = success(await run("ok.sh", { prompt: "anything", jsonSchema: VERDICT, sessionId: "mine" }))
    expect(reply.sessions[0]).toBe("mine")
  })

  /**
   * A `resume` names a session that already exists. Publishing a fresh id for it would point a
   * supervisor at a session that never will, and a crash inside the first heartbeat interval would
   * then be recovered against that ghost.
   */
  test("is the resumed session on a resume call, never a fresh id", async () => {
    const beats: Array<Beat> = []
    const reply = success(await run("ok.sh", { prompt: "anything", resume: "the-real-session" }, beats))
    expect(reply.sessions[0]).toBe("the-real-session")
    expect(beats[0]?.sessionId).toBe("the-real-session")
  })
})

describe("the transport's own robustness", () => {
  /**
   * The child exits 0 with a decodable verdict while a descendant it started still holds the
   * inherited stdout and stderr pipes open. Waiting on stream EOF rather than the child's own exit
   * hangs here until the tool bound fires, then reports CLAUDE_IDLE_TIMEOUT for a run that
   * succeeded. The bound is set to 3 seconds so a regression fails fast rather than hanging.
   */
  test("returns the verdict when a descendant outlives the child holding its pipes", async () => {
    const started = Date.now()
    const reply = success(
      await run("pipe-holder.sh", { prompt: "anything", jsonSchema: VERDICT, bounds: { toolSecs: 3, generatingSecs: 3 } })
    )
    expect(reply.verdict).toEqual({ status: "pass" })
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)

  /**
   * A caller that gives up on an agent node — a timeout upstream, a cancelled run — must take the
   * child with it, rather than leave it working to its own idle bound for an answer nobody will
   * read. The fixture's grandchild is the assertion: nothing but a process-group signal reaches it,
   * and only the scope's release sends one.
   *
   * This holds because the wait for the child is interruptible, so the fiber unwinds and the
   * `acquireRelease` finalizer runs. Worth pinning explicitly: it is a property of how the wait is
   * written, invisible in every other test here, and nothing else would notice it regressing.
   */
  test("interrupting the call reaps the child instead of running it to the bound", async () => {
    const scratch = scratchDir("interrupt", "grandchild.pid")
    try {
      const started = Date.now()
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            liveClaudeAgent.prompt({ prompt: "anything", cwd: scratch.dir }).pipe(
              Effect.provide(Layer.mergeAll(
                Layer.succeed(ClaudeBin, fixture("grandchild.sh")),
                claudeTimingLayer(QUICK)
              ))
            )
          )
          // The pid file appearing means the fixture is past its own startup and the group exists.
          yield* Effect.promise(async () => {
            while (!(await Bun.file(scratch.file).exists())) await Bun.sleep(10)
          })
          yield* Fiber.interrupt(fiber)
        })
      )

      // The generating bound here is the default 60s. Returning in a fraction of that is the point.
      expect(Date.now() - started).toBeLessThan(10_000)
      const grandchild = Number((await Bun.file(scratch.file).text()).trim())
      expect(Number.isInteger(grandchild)).toBe(true)
      await awaitReaped(grandchild)
      expect(() => process.kill(grandchild, 0)).toThrow()
      expect(liveChildCount()).toBe(0)
    } finally {
      scratch.cleanup()
    }
  }, 20_000)

  test("reassembles lines split across writes, including a multi-byte character", async () => {
    const reply = success(await run("chunked.sh", { prompt: "anything" }))
    expect(reply.verdict).toEqual({ status: "pass", note: "café" })
  })

  /**
   * A target repo's `.env` puts an arbitrary credential in the parent's own environment (this is
   * what Bun's auto-load does today), and it must not reach a session spawned to work in that
   * repo, no more than an `ANTHROPIC_*` key may. `PATH` reaching through alongside them proves the
   * manifest is a named allowlist, not a scrub that happens to drop everything.
   */
  test("nothing outside the manifest reaches the child's environment; PATH does", async () => {
    process.env["ANTHROPIC_API_KEY"] = "must-not-reach-the-child"
    process.env["TARGET_REPO_SECRET"] = "must-not-reach-the-child"
    try {
      const reply = success(await run("env-report.sh", { prompt: "anything" }))
      expect(reply.verdict).toEqual({ anthropic: "absent", foreign: "absent", hasPath: true })
    } finally {
      delete process.env["ANTHROPIC_API_KEY"]
      delete process.env["TARGET_REPO_SECRET"]
    }
  })

  /** The hatch re-admits `ANTHROPIC_*` and nothing else, the rule `env.ts` states. */
  test("KEEP_ANTHROPIC_ENV=1 re-admits ANTHROPIC_* onto the manifest env, not the whole host env", async () => {
    process.env["ANTHROPIC_API_KEY"] = "let-it-through"
    process.env["KEEP_ANTHROPIC_ENV"] = "1"
    process.env["TARGET_REPO_SECRET"] = "must-still-not-reach-the-child"
    try {
      const reply = success(await run("env-report.sh", { prompt: "anything" }))
      expect(reply.verdict).toEqual({ anthropic: "let-it-through", foreign: "absent", hasPath: true })
    } finally {
      delete process.env["ANTHROPIC_API_KEY"]
      delete process.env["KEEP_ANTHROPIC_ENV"]
      delete process.env["TARGET_REPO_SECRET"]
    }
  })

  /**
   * A dispatch that declares a need the composed environment cannot satisfy fails before any
   * process starts. The scratch file staying absent is the proof that no process ran:
   * `echo-argv.sh` writes it as its first act. The host holding this value changes nothing about the
   * reason, which manifest membership alone decides (`env.ts`'s `envShortfall`, pinned in
   * `env.test.ts`); it is here because a target repo's `.env` is where such a value comes from.
   */
  test("a withheld requirement fails CLAUDE_ENV_REQUIREMENT before any process spawns", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    process.env["TARGET_REPO_SECRET"] = "present-but-not-on-the-manifest"
    try {
      const error = failure(
        await run("echo-argv.sh", { prompt: "anything", cwd: scratch.dir, requires: ["TARGET_REPO_SECRET"] })
      )
      expect(error._tag).toBe("CLAUDE_ENV_REQUIREMENT")
      if (error._tag !== "CLAUDE_ENV_REQUIREMENT") return
      expect(error.reason).toBe("withheld")
      expect(error.name).toBe("TARGET_REPO_SECRET")
      expect(await Bun.file(scratch.file).exists()).toBe(false)
    } finally {
      delete process.env["TARGET_REPO_SECRET"]
      scratch.cleanup()
    }
  })

  test("an unset requirement fails CLAUDE_ENV_REQUIREMENT distinctly from a withheld one", async () => {
    const scratch = scratchDir("echo-argv", "argv.txt")
    // GRAPH_TRACE_FILE is on ENV_MANIFEST (env.ts); the reason has to read "unset" for a manifest
    // name the host does not hold, never "withheld" — a manifest edit would not change anything here.
    const previous = process.env["GRAPH_TRACE_FILE"]
    delete process.env["GRAPH_TRACE_FILE"]
    try {
      const error = failure(
        await run("echo-argv.sh", { prompt: "anything", cwd: scratch.dir, requires: ["GRAPH_TRACE_FILE"] })
      )
      expect(error._tag).toBe("CLAUDE_ENV_REQUIREMENT")
      if (error._tag !== "CLAUDE_ENV_REQUIREMENT") return
      expect(error.reason).toBe("unset")
      expect(error.name).toBe("GRAPH_TRACE_FILE")
      expect(await Bun.file(scratch.file).exists()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env["GRAPH_TRACE_FILE"]
      else process.env["GRAPH_TRACE_FILE"] = previous
      scratch.cleanup()
    }
  })

  /**
   * A heartbeat that never settles must not disarm the watchdog. `ignoreCause` bounds a beat that
   * *fails*; it does nothing for one that hangs, and the watchdog polls on a schedule that only
   * re-ticks once the previous tick has completed. So an awaited beat puts the run's only idle
   * protection behind the liveness of a pointer write to disk — the one subsystem whose failure
   * mode the transport already assumes.
   */
  test("a Heartbeat that never settles still leaves the idle bound armed", async () => {
    const wedged: HeartbeatService = { beat: () => Effect.never }
    const result = await Effect.runPromise(
      Effect.result(
        liveClaudeAgent.prompt({ prompt: "anything", bounds: { generatingSecs: 1 } }).pipe(
          Effect.provide(Layer.mergeAll(
            Layer.succeed(ClaudeBin, fixture("stalls.sh")),
            Layer.succeed(Heartbeat, wedged),
            claudeTimingLayer({ ...QUICK, beatMs: 1 })
          ))
        )
      )
    )
    expect(failure(result)._tag).toBe("CLAUDE_IDLE_TIMEOUT")
  }, 20_000)

  test("a throwing Heartbeat is a missed beat, never a defect that kills the call", async () => {
    const exploding: HeartbeatService = {
      beat: () => Effect.sync(() => {
        throw new Error("ENOSPC: no space left on device")
      })
    }
    const result = await Effect.runPromise(
      Effect.result(
        liveClaudeAgent.prompt({ prompt: "anything", jsonSchema: VERDICT }).pipe(
          Effect.provide(Layer.mergeAll(Layer.succeed(ClaudeBin, fixture("ok.sh")), Layer.succeed(Heartbeat, exploding)))
        )
      )
    )
    expect(success(result).verdict).toEqual({ status: "pass" })
  })

  test("the raw result line rides out whole, undeclared CLI fields included", async () => {
    const reply = success(await run("ok.sh", { prompt: "anything", jsonSchema: VERDICT }))
    // `total_cost_usd` is declared on the schema; `subtype` is too. The point is that `result`
    // carries the parsed wire object rather than the decoded struct, so a field this transport
    // never declared still reaches a consumer.
    const raw = reply.result as Record<string, unknown>
    expect(raw["session_id"]).toBe("sess-ok")
    expect(raw["structured_output"]).toEqual({ status: "pass" })
  })

  test("concurrent calls each reap their own child and leave the registry empty", async () => {
    const replies = await Promise.all([
      run("ok.sh", { prompt: "a", jsonSchema: VERDICT }),
      run("prose.sh", { prompt: "b" }),
      run("ok.sh", { prompt: "c", jsonSchema: VERDICT }),
      run("prose.sh", { prompt: "d" })
    ])
    for (const reply of replies) expect(success(reply).verdict).toEqual({ status: "pass" })
    expect(liveChildCount()).toBe(0)
    // The refcounted handlers detach with the last child, so nothing accumulates on `process`.
    expect(process.listenerCount("SIGTERM")).toBe(0)
  })
})
