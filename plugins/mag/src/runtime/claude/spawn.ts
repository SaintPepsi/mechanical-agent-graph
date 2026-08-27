import { Cause, Effect, Fiber, Ref, Schedule, Stream } from "effect"
import { composeEnv, envShortfall } from "mag/runtime/claude/env"
import {
  AgentExit,
  type AgentExitReason,
  EnvRequirement,
  type IdleBound,
  IdleTimeout,
  StartupSilence,
  type TransportError
} from "mag/runtime/claude/errors"
import { lineSubtype, lineType } from "mag/runtime/claude/messages"
import { killGroup, releaseChild, trackChild } from "mag/runtime/claude/reaper"
import { type RateLimitObservation, terminalFailure } from "mag/runtime/claude/usage-limit"

/**
 * One `claude -p` invocation: spawn it, stream its stdout, watch it for silence, reap its process
 * group, and hand back the raw `result` line.
 *
 * Semantics live one layer up in `agent.ts`. This module knows about processes, lines and time.
 *
 * Everything here runs as Effect fibers inside one scope: the readers, the watchdog, each heartbeat
 * and the deferred kill. Scope close interrupts all of them, and the child's `acquireRelease` reaps
 * its process group.
 *
 * The one rule that keeps this honest is that **nothing on the run's critical path waits on
 * something that can hang**. Every failure mode here has been a latency, not an error: a heartbeat
 * that never settles disarms the watchdog if the tick awaits it, because the poll schedule only
 * re-ticks once the tick completes, and `ignoreCause` bounds a beat that fails rather than one that
 * hangs. Waits that must happen are interruptible; work that need not be waited on is forked.
 */

export interface IdleBounds {
  readonly generatingSecs: number
  readonly toolSecs: number
  readonly startupSecs: number
}

/** Defaults for the idle-watchdog bounds, overridable per call. */
export const DEFAULT_BOUNDS: IdleBounds = { generatingSecs: 60, toolSecs: 900, startupSecs: 120 }

/**
 * The transport's own clock, injected beside `now` for the same reason: a test that shrinks an idle
 * bound to one second still waits a full `pollMs` tick and `termGraceMs` grace on the real clock,
 * because the watchdog's schedule does not consult `deps.now`. Production uses {@link DEFAULT_TIMING}.
 */
export interface SpawnTiming {
  /** The watchdog's tick. */
  readonly pollMs: number
  /** The grace period between an idle `SIGTERM` and its `SIGKILL`. */
  readonly termGraceMs: number
  /** At most one heartbeat per this interval. */
  readonly beatMs: number
  /**
   * How long the exited child's pipes are given to drain. Whatever the child wrote is already
   * buffered; this window exists for a descendant that inherited the pipes and has not closed them.
   */
  readonly drainGraceMs: number
}

export const DEFAULT_TIMING: SpawnTiming = {
  pollMs: 5_000,
  termGraceMs: 5_000,
  beatMs: 10_000,
  drainGraceMs: 2_000
}

/**
 * The tools a spawned agent may use. The allowlist pre-approves each tool outright;
 * `--permission-mode bypassPermissions` exits at startup on root hosts, which makes the allowlist
 * the supported mechanism.
 */
export const ALLOWED_TOOLS =
  "Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite,WebFetch,WebSearch,NotebookEdit,Skill"

/**
 * `--setting-sources project --strict-mcp-config`: isolates a spawned session from the invoker's
 * `~/.claude`.
 *
 * Proven headlessly, not assumed from the flag pair's help text (a probe run from the repo root,
 * discriminated by a marker agent): `--setting-sources project` alone drops every user-level
 * source (memory, hooks, agents, skills) while keeping the target repo's own CLAUDE.md, agents and
 * settings; the one leak it does not close is MCP, where the invoker's servers stay connected, and
 * `--strict-mcp-config` closes that. Together they match a scratch `CLAUDE_CONFIG_DIR` on every
 * observable axis without touching credentials — `CLAUDE_CONFIG_DIR` breaks auth outright, since
 * credentials live in `~/.claude/.credentials.json` and a scratch dir has none.
 *
 * Two deliberate widths in that isolation: `--strict-mcp-config` with no `--mcp-config` also drops
 * the target repo's own `.mcp.json` (headless children could not approve project servers anyway),
 * and `--setting-sources project` drops `.claude/settings.local.json` (the `local` source is
 * invoker-machine state, which is what isolation removes).
 */
export const ISOLATION_FLAGS = ["--setting-sources", "project", "--strict-mcp-config"] as const

export interface SpawnRequest {
  readonly prompt: string
  /**
   * `--model`: overrides the dispatched agent's own pinned `model:` frontmatter.
   *
   * Proven headlessly, not assumed from the flag reaching argv (a probe run from the repo root, same
   * convention as `agent`'s probe below): asked to name its own model, `claude -p
   * --agent effect-expert` (effect-expert's frontmatter pins `model: sonnet`) reported
   * `modelUsage: { "claude-sonnet-5": ... }`; the identical call with `--model opus` added reported
   * `modelUsage: { "claude-opus-5": ... }`. `--model` wins. The result message's own text reply is
   * not trustworthy evidence — it named a checkpoint the `modelUsage` field contradicted — so the
   * mechanical signal is `modelUsage`/`canonicalModel`, never a model's self-report.
   *
   * Unset means {@link DEFAULT_MODEL}: every spawn passes `--model` explicitly, so a forgotten
   * assignment falls to the cheap tier instead of whatever the invoker's account defaults to.
   */
  readonly model?: string
  readonly jsonSchema?: string
  readonly resume?: string
  readonly sessionId?: string
  /**
   * `--agent`: the session runs as a named agent from the target repo's `.claude/agents/`.
   *
   * Proven headlessly, not read off the help text (a probe run from the repo root):
   * `claude -p --agent effect-expert` completed a sentence that exists only in
   * `.claude/agents/effect-expert.md` ("A ruling arrives in your brief; you implement it, you do
   * not redesign it."), and the identical prompt without the flag answered NOT-PRESENT.
   */
  readonly agent?: string
  readonly bounds: IdleBounds
  /** The child's working directory. Omitted means inherit (`Bun.spawn`'s own default). */
  readonly cwd?: string
  /**
   * `--setting-sources project --strict-mcp-config`, appended when `true`. Absent means inherit the
   * invoker's `~/.claude`, today's behaviour. See {@link ISOLATION_FLAGS}'s doc comment for the
   * recorded probe.
   */
  readonly isolated?: boolean
  /**
   * Names this dispatch's work needs present in the composed environment (`env.ts`'s
   * `ENV_MANIFEST`). Unset or empty means the call declares no need beyond the manifest.
   */
  readonly requires?: readonly string[]
}

export interface SpawnOutcome {
  /** The `result` line, parsed but not yet decoded. */
  readonly resultLine: unknown
  readonly stderrTail: string
  /** The last session id the stream reported. */
  readonly streamSessionId: string
  /** The last rate-limit `api_retry` seen, with the moment it arrived. */
  readonly rateLimit: RateLimitObservation | null
}

/** Everything a spawn needs from outside itself. */
export interface SpawnDeps {
  readonly bin: string
  readonly beat: (sessionId: string, beatEpochSecs: number) => Effect.Effect<void>
  readonly now: () => number
  readonly timing: SpawnTiming
}

/**
 * The model a spawn runs when its request names none. `--model` outranks both the agent's
 * frontmatter pin and the invoker's account default (probe above), so passing it unconditionally
 * is the one place that guarantees no dispatch silently runs an expensive tier.
 */
export const DEFAULT_MODEL = "sonnet"

/** Assembles argv. One field, one flag. */
export const buildArgv = (bin: string, request: SpawnRequest): [string, ...string[]] => {
  const argv: string[] = [
    bin,
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--allowedTools",
    ALLOWED_TOOLS
  ]
  argv.push("--model", request.model ?? DEFAULT_MODEL)
  if (request.agent !== undefined) argv.push("--agent", request.agent)
  if (request.jsonSchema !== undefined) argv.push("--json-schema", request.jsonSchema)
  if (request.resume !== undefined) argv.push("--resume", request.resume)
  else if (request.sessionId !== undefined) argv.push("--session-id", request.sessionId)
  if (request.isolated === true) argv.push(...ISOLATION_FLAGS)
  return argv as [string, ...string[]]
}

const STDERR_TAIL_CHARS = 2_000

/** Readable text for an arbitrary thrown value, for a field that a human reads to debug. */
const describe = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type WatchMode = "GENERATING" | "WAITING"

/**
 * The bounds the watchdog enforces: `IdleTimeout`'s two, plus the startup bound that is its own
 * tag and so has no place in `IdleBound`.
 */
type Bound = IdleBound | "startup"

interface Timeout {
  readonly silentSecs: number
  readonly boundSecs: number
  readonly bound: Bound
}

/**
 * Everything the watchdog tick and the two stream readers share, held as one value in one `Ref`.
 *
 * One record rather than a `Ref` per field, because both sides read and write across fields. The
 * tick needs `started`, `mode` and `lastEventAt` as one consistent snapshot to pick a bound; with
 * independent `Ref`s each read is a scheduling point, and a line landing between two of them times
 * the run out against a stale `lastEventAt` paired with fresh state. A line likewise moves four
 * fields at once and should be one transition, exactly as it was when this was a synchronous
 * closure.
 */
interface Watch {
  readonly lastEventAt: number
  readonly lastBeatAt: number
  readonly mode: WatchMode
  readonly started: boolean
  readonly timedOut: Timeout | null
  readonly streamSessionId: string
  readonly rateLimit: RateLimitObservation | null
  readonly resultLine: unknown
  readonly stderrTail: string
  readonly streamError: unknown
}

/**
 * Which bound is in force. Before `system`/`init` arrives the startup bound applies; after it, the
 * generating bound while the model is producing tokens and the tool bound otherwise.
 */
export const boundFor = (started: boolean, mode: WatchMode, bounds: IdleBounds): {
  readonly secs: number
  readonly bound: Bound
} =>
  !started
    ? { secs: bounds.startupSecs, bound: "startup" }
    : mode === "GENERATING"
    ? { secs: bounds.generatingSecs, bound: "generating" }
    : { secs: bounds.toolSecs, bound: "tool" }

/**
 * One stdout line folded into the watch state. Pure: the clock arrives as an argument.
 *
 * Any line at all is liveness, blank ones included — the content decides which bound applies, never
 * whether the process is alive. A line that is not JSON still counts as a sign of life and is
 * otherwise ignored.
 */
export const applyLine = (now: number, line: string, w: Watch): Watch => {
  const beat: Watch = { ...w, lastEventAt: now }
  if (line.trim() === "") return beat

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return beat
  }

  const session = (parsed as { session_id?: unknown }).session_id
  const seen: Watch = typeof session === "string" && session !== ""
    ? { ...beat, streamSessionId: session }
    : beat

  const type = lineType(parsed)
  const subtype = lineSubtype(parsed)

  if (type === "system" && subtype === "init") return { ...seen, started: true }
  if (type === "system" && subtype === "api_retry") {
    const event = parsed as { error?: unknown; retry_delay_ms?: unknown }
    // The delay feeds arithmetic that becomes a reset timestamp, so it is checked for the shape
    // that arithmetic needs. The field belongs to the CLI, and this transport pins no version.
    const delay = event.retry_delay_ms
    return event.error === "rate_limit" && typeof delay === "number" && Number.isFinite(delay) && delay > 0
      ? { ...seen, rateLimit: { observedAtMs: now, retryDelayMs: delay } }
      : seen
  }
  if (type === "stream_event") {
    const event = (parsed as { event?: { type?: unknown } }).event
    if (event?.type === "message_start") return { ...seen, mode: "GENERATING" }
    if (event?.type === "message_stop") return { ...seen, mode: "WAITING" }
    return seen
  }
  if (type === "result") return { ...seen, resultLine: parsed }
  return seen
}

const timeoutError = (timedOut: Timeout, streamSessionId: string, stderrTail: string): TransportError =>
  timedOut.bound === "startup"
    ? new StartupSilence({
      boundSecs: timedOut.boundSecs,
      silentSecs: timedOut.silentSecs,
      stderrTail
    })
    : new IdleTimeout({
      bound: timedOut.bound,
      boundSecs: timedOut.boundSecs,
      silentSecs: timedOut.silentSecs,
      sessionId: streamSessionId,
      stderrTail
    })

/** What one watchdog tick decided, taken out of the atomic update and acted on outside it. */
interface Tick {
  readonly beatFor: string | null
  readonly kill: boolean
}

/**
 * Runs one invocation to completion.
 *
 * The child is spawned `detached`, so it leads its own process group and one negative-pid signal
 * reaches it and everything it started. `Effect.acquireRelease` reaps that group on completion and
 * on interruption; `reaper.ts` covers the parent dying.
 *
 * An idle kill sends `SIGTERM` and then `SIGKILL` after a grace period; the classification decided
 * at that moment is the one that surfaces, whatever the process does on the way out.
 */
export const spawnOnce = (
  deps: SpawnDeps,
  request: SpawnRequest
): Effect.Effect<SpawnOutcome, TransportError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const argv = buildArgv(deps.bin, request)
      const pinnedSession = request.resume ?? request.sessionId ?? ""

      // Composed and checked before any process exists, so no spawn can bypass the boundary. A
      // shortfall fails the whole call here rather than inside `Effect.try`: there is no process
      // yet for `acquireRelease`'s finalizer to reap.
      const env = composeEnv(process.env)
      const shortfall = envShortfall(request.requires ?? [], env)
      if (shortfall !== null) return yield* Effect.fail(new EnvRequirement({ ...shortfall, sessionId: pinnedSession }))

      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn(argv, {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              detached: true,
              cwd: request.cwd,
              env
            } as Parameters<typeof Bun.spawn>[1]),
          catch: (cause) =>
            new AgentExit({
              reason: "not-executable",
              exitCode: null,
              signal: "",
              stderrTail: cause instanceof Error ? cause.message : String(cause),
              sessionId: pinnedSession
            })
        }).pipe(Effect.tap((spawned) => Effect.sync(() => trackChild(spawned.pid)))),
        (spawned) => Effect.sync(() => releaseChild(spawned.pid))
      )

      const watch = yield* Ref.make<Watch>({
        lastEventAt: deps.now(),
        // Not zero: `agent.ts` beats the pinned session immediately before this spawn, and the
        // watchdog's first tick runs at once rather than after a poll interval. Starting the clock
        // at zero makes `now - lastBeatAt >= beatMs` true on that first tick and writes the same
        // session again milliseconds later, three times over a fully-nudged call.
        lastBeatAt: deps.now(),
        mode: "WAITING",
        started: false,
        timedOut: null,
        streamSessionId: pinnedSession,
        rateLimit: null,
        resultLine: null,
        stderrTail: "",
        streamError: null
      })

      /**
       * A reader fiber, with any escape recorded rather than raised. `catchCause` covers the defect
       * channel too: this transport promises six tags and nothing else, and an unhandled throw out
       * of a background fiber is the one shape that could cross it.
       */
      /** Latches the first thing that went wrong in a background fiber, whatever channel it used. */
      const latch = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
        Ref.update(watch, (w) => (w.streamError === null ? { ...w, streamError: Cause.squash(cause) } : w))

      const reader = <E>(pipeline: Effect.Effect<void, E>) => Effect.forkScoped(Effect.catchCause(pipeline, latch))

      const bytes = (stream: unknown) =>
        Stream.fromReadableStream({
          evaluate: () => stream as ReadableStream<Uint8Array>,
          onError: (cause) => cause
        })

      // Reading starts before anything is awaited: a child whose pipe fills while nobody drains it
      // blocks, and would be killed by its own idle bound. `splitLines` matches the hand-rolled
      // reader it replaces on every case that mattered — chunk-split lines, a multi-byte character
      // split across writes, blank lines, and a trailing line with no newline after it.
      const stdoutDone = yield* reader(
        bytes(child.stdout).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.flatMap(
              Effect.sync(deps.now),
              (now) => Ref.update(watch, (w) => applyLine(now, line, w))
            ))
        )
      )

      /**
       * A rolling tail rather than the whole stream. A child that spews stderr for the length of a
       * 900-second tool bound (a crash-looping retry, a verbose MCP server) would otherwise grow the
       * parent's memory without limit before the tail is taken.
       */
      const stderrDone = yield* reader(
        bytes(child.stderr).pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Ref.update(watch, (w) => ({ ...w, stderrTail: (w.stderrTail + text).slice(-STDERR_TAIL_CHARS) })))
        )
      )

      /** The pending SIGKILL, so the child's own exit can cancel it rather than the scope's close. */
      const deferredKill = yield* Ref.make<Fiber.Fiber<void> | null>(null)

      /**
       * One poll. The decision is taken inside `Ref.modify`, so the timeout latch is set in the same
       * atomic step that reads the bound it was decided against — no window in which two ticks both
       * see an un-latched timeout and both kill. The signalling happens outside, where it belongs.
       */
      const tick = Effect.gen(function* () {
        const now = deps.now()
        const decision = yield* Ref.modify(watch, (w): [Tick, Watch] => {
          const due = now - w.lastBeatAt >= deps.timing.beatMs
          const beaten: Watch = due ? { ...w, lastBeatAt: now } : w
          const beatFor = due ? beaten.streamSessionId || pinnedSession : null

          if (w.timedOut !== null) return [{ beatFor, kill: false }, beaten]
          const { bound, secs } = boundFor(w.started, w.mode, request.bounds)
          if (now - w.lastEventAt < secs * 1_000) return [{ beatFor, kill: false }, beaten]

          const silentSecs = Math.round((now - w.lastEventAt) / 1_000)
          return [{ beatFor, kill: true }, { ...beaten, timedOut: { bound, boundSecs: secs, silentSecs } }]
        })

        // Forked, not awaited. A heartbeat is a pointer write to a disk this transport already
        // assumes can be sick, and `Schedule.spaced` only re-ticks once
        // the tick settles — so awaiting a beat that never returns parks the run's only idle
        // protection behind it, unbounded. `ignoreCause` bounds a beat that *fails*, never one that
        // hangs. Awaiting it also delays the SIGTERM of an already-decided kill by its own latency.
        if (decision.beatFor !== null) {
          yield* Effect.forkScoped(Effect.ignoreCause(deps.beat(decision.beatFor, Math.floor(now / 1_000))))
        }

        if (decision.kill) {
          yield* Effect.sync(() => killGroup(child.pid, "SIGTERM"))
          // Held so the child exiting on the SIGTERM can interrupt the sleep. Scope close alone is
          // too late: it happens after the drain window, so with a grace shorter than that window
          // the SIGKILL fires into an already-dead group — harmless until the OS reuses the pgid.
          const killer = yield* Effect.forkScoped(
            Effect.andThen(
              Effect.sleep(deps.timing.termGraceMs),
              Effect.sync(() => killGroup(child.pid, "SIGKILL"))
            )
          )
          yield* Ref.set(deferredKill, killer)
        }
      })

      // A defect in the tick would otherwise kill the watchdog fiber silently: nothing observes its
      // exit, so the run would continue unbounded and unbeaten while looking healthy.
      const watchdog = yield* Effect.forkScoped(
        Effect.catchCause(Effect.repeat(tick, Schedule.spaced(deps.timing.pollMs)), latch)
      )

      // The child's own exit ends the run. Waiting on stream EOF instead would hang on any
      // descendant that inherited the pipes and outlived the child — a backgrounded MCP server, say
      // — and the idle bound would then fire on a run that had already exited 0 with a decodable
      // verdict. `Effect.callback` keeps the wait interruptible, which is what lets the scope's
      // release reap the group when a caller gives up on this node.
      // Both arms resume: `child.exited` is documented as resolve-only, and a rejection that never
      // resumed would hang the run outright rather than surface as a tag.
      yield* Effect.callback<void>((resume) => {
        void child.exited.then(() => resume(Effect.void), () => resume(Effect.void))
      })

      // Before anything else: the child is gone, so a SIGKILL still scheduled against its pgid has
      // nothing left to reach and everything to lose once the OS reuses the number.
      const pendingKill = yield* Ref.get(deferredKill)
      if (pendingKill !== null) yield* Fiber.interrupt(pendingKill)
      yield* Fiber.interrupt(watchdog)

      const exitCode = child.exitCode
      const signal = child.signalCode ?? ""

      // Bounded, because a descendant may still be holding the pipes open. Whatever the child itself
      // wrote is already buffered and arrives well inside this window; past it the readers are
      // interrupted at scope close, which abandons their pending read rather than waiting on a pipe
      // nobody is going to close.
      yield* Effect.ignore(
        Effect.timeout(Fiber.awaitAll([stdoutDone, stderrDone]), deps.timing.drainGraceMs)
      )

      const w = yield* Ref.get(watch)

      if (w.timedOut !== null) {
        return yield* Effect.fail(timeoutError(w.timedOut, w.streamSessionId, w.stderrTail))
      }
      if (w.streamError !== null) {
        return yield* Effect.fail(
          new AgentExit({
            reason: "stream-error",
            exitCode,
            signal,
            // A squashed cause can be any thrown value, and `String` renders a plain object as
            // "[object Object]" — the least useful thing to find in a failure report.
            stderrTail: describe(w.streamError).slice(0, STDERR_TAIL_CHARS),
            sessionId: w.streamSessionId
          })
        )
      }

      // A run that died without a result message leaves the stream's `api_retry` event and the
      // stderr tail as its signals. `api_error_status` belongs to a result message, so it arrives
      // only where there is one to read, and `agent.ts` classifies that case.
      const terminal = (reason: AgentExitReason): TransportError =>
        terminalFailure(
          { apiErrorStatus: null, rateLimit: w.rateLimit, stderrTail: w.stderrTail },
          w.streamSessionId,
          () => new AgentExit({ reason, exitCode, signal, stderrTail: w.stderrTail, sessionId: w.streamSessionId })
        )

      // `child.exitCode` is null when a signal ended the process, which is the shape `AgentExit`
      // documents. The awaited `child.exited` reports 128+signal instead and would mask it.
      if (exitCode !== 0) return yield* Effect.fail(terminal(signal === "" ? "nonzero-exit" : "signal"))
      if (w.resultLine === null) return yield* Effect.fail(terminal("no-result-message"))

      return {
        resultLine: w.resultLine,
        stderrTail: w.stderrTail,
        streamSessionId: w.streamSessionId,
        rateLimit: w.rateLimit
      }
    })
  )
