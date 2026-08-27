import { Effect, Predicate } from "effect"
import { AgentExit, NullVerdict, type TransportError } from "mag/runtime/claude/errors"
import { decodeResultMessage, type ResultMessage } from "mag/runtime/claude/messages"
import {
  type ClaudeAgentService,
  ClaudeBin,
  ClaudeIsolation,
  type ClaudePrint,
  type ClaudeReply,
  ClaudeTiming,
  Heartbeat
} from "mag/runtime/claude/service"
import { DEFAULT_BOUNDS, type IdleBounds, type SpawnDeps, type SpawnOutcome, spawnOnce } from "mag/runtime/claude/spawn"
import { asUsageLimit, terminalFailure } from "mag/runtime/claude/usage-limit"
import { parseResult } from "mag/runtime/claude/verdict"

/**
 * Orchestration: one `prompt` call, its nudges, and what it accumulates.
 *
 * `spawn.ts` owns processes and time. This module owns meaning: which spawn happens, what counts as
 * a verdict, and which of the six tags a failure carries.
 */

/**
 * Sent when a schemaless reply holds nothing parseable, even by the embedded-object scan. The
 * work is already done inside the session, so a `--resume` re-emits it for cents where
 * re-running the node costs dollars.
 */
export const NUDGE_BRIEF =
  "Your previous reply was not parseable as JSON. Reply now with ONLY the raw JSON object for this step's structured output — no prose before or after it, no code fences, no markdown emphasis."

/**
 * Sent after a spawn fails outright. The model's structured output sometimes embeds a required
 * field's content as literal text inside another field's string, the CLI rejects it against
 * `--json-schema`, and `claude -p` exits 1 without taking another turn. The session stays
 * resumable, so one corrective resume re-emits the finished verdict for cents.
 */
export const CORRECTIVE_NUDGE_BRIEF =
  "Your previous structured output failed schema validation: a required field's content was written as literal text inside another field's string value instead of being its own property. Re-emit this step's verdict now as ONE clean JSON object where every required field is its own top-level key — no field content nested inside another field's string, no prose, no code fences, no markdown, no XML-style tags."

/** How much of an unusable reply travels on `CLAUDE_NULL_VERDICT`. */
export const SNIPPET_CHARS = 300

/** Everything orchestration needs from outside itself. */
export interface AgentDeps extends SpawnDeps {
  readonly newSessionId: () => string
  /** The run-wide isolation policy, resolved once from `ClaudeIsolation`. */
  readonly isolated: boolean
}

/** One spawn and its decoded result message. */
interface Attempt {
  readonly outcome: SpawnOutcome
  readonly result: ResultMessage
}

const snippet = (value: unknown): string =>
  (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).slice(0, SNIPPET_CHARS)

/** The session id a failure carries. `CLAUDE_STARTUP_SILENCE` carries none: it died before init. */
const sessionIdOf = (error: TransportError): string => ("sessionId" in error ? error.sessionId : "")

/**
 * Which failure surfaces when both a spawn and its corrective resume fail. An idle kill names the
 * dispatch that went silent and earns its own escalation, so it wins over anything else; the
 * original wins a tie.
 */
const preferIdle = (original: TransportError, second: TransportError): TransportError =>
  original._tag === "CLAUDE_IDLE_TIMEOUT"
    ? original
    : second._tag === "CLAUDE_IDLE_TIMEOUT"
    ? second
    : original

/** Whether a result message reports a failed run. */
const isFailedResult = (result: ResultMessage): boolean =>
  result.is_error === true || (result.subtype !== undefined && result.subtype !== "success")

/** `structured_output` when it holds a usable object. */
const fromStructured = (result: ResultMessage): Record<string, unknown> | null =>
  Predicate.isObject(result.structured_output) ? result.structured_output : null

/**
 * One spawn, plus the decode of its `result` line into a typed message.
 *
 * A result line the transport cannot read is a terminal failure like any other, so it is offered
 * the same rate-limit classification: a run that hit a limit and then emitted something unreadable
 * still carries a reset time worth surfacing.
 */
const spawnAndDecode = (deps: SpawnDeps, request: Parameters<typeof spawnOnce>[1]): Effect.Effect<Attempt, TransportError> =>
  Effect.gen(function* () {
    const outcome = yield* spawnOnce(deps, request)
    const result = yield* decodeResultMessage(outcome.resultLine).pipe(
      Effect.mapError((cause): TransportError =>
        terminalFailure(
          { apiErrorStatus: null, rateLimit: outcome.rateLimit, stderrTail: outcome.stderrTail },
          outcome.streamSessionId,
          () =>
            new AgentExit({
              reason: "undecodable-result",
              exitCode: 0,
              signal: "",
              stderrTail: String(cause).slice(0, SNIPPET_CHARS),
              sessionId: outcome.streamSessionId
            })
        )
      )
    )
    return { outcome, result }
  })

/**
 * The call: pin a session, publish it, spawn, and turn what came back into a verdict or a tag.
 *
 * The corrective resume covers a spawn that failed. A reply that arrived and held no verdict takes
 * the schemaless nudge instead, and a schema'd call that decodes badly fails on the spot.
 */
export const promptWith = <A>(deps: AgentDeps, request: ClaudePrint<A>): Effect.Effect<ClaudeReply<A>, TransportError> =>
  Effect.gen(function* () {
    const bounds: IdleBounds = { ...DEFAULT_BOUNDS, ...request.bounds }

    /**
     * The session this call resumes, or the one it pins for a fresh run. Published before the first
     * spawn, so a spawn that crashes without emitting anything still leaves a resumable id behind,
     * for the corrective resume here and for the launcher's supervisor. A `resume` call names a
     * session that already exists, and publishing a freshly generated id for it would point a
     * supervisor at a session that never will.
     */
    const pinned = request.resume ?? request.sessionId ?? deps.newSessionId()

    // Awaited, but bounded, and cause-ignored either way.
    //
    // Awaited because this write is the guarantee: a supervisor recovering a crashed run reads it
    // to learn which session to resume, so it has to be on disk before a process exists that could
    // crash. Forking it makes that a race the fast-failure case loses, which is the one case it
    // exists for.
    //
    // Bounded because a beat that hangs rather than fails would otherwise take the whole call with
    // it before anything is spawned — `ignoreCause` bounds a failure, never a latency. `beatMs` is
    // the bound because a beat slower than the interval between beats is by definition wedged.
    yield* Effect.ignoreCause(
      Effect.timeout(deps.beat(pinned, Math.floor(deps.now() / 1_000)), deps.timing.beatMs)
    )

    // `agent` rides along on every spawn `base` seeds, resumes included: a nudge or corrective
    // resume re-enters the same session, and that session runs as the agent that started it.
    // `isolated` follows the same rule: a resumed session keeps the shape of the session that
    // started it.
    const base = {
      prompt: request.prompt,
      model: request.model,
      agent: request.agent,
      jsonSchema: request.jsonSchema?.serialized,
      resume: request.resume,
      sessionId: request.resume === undefined ? pinned : undefined,
      bounds,
      cwd: request.cwd,
      isolated: deps.isolated,
      requires: request.requires
    }

    const sessions: Array<string> = [pinned]
    let costUsd: number | null = null
    let attempts = 0

    const record = (attempt: Attempt): Attempt => {
      const cost = attempt.result.total_cost_usd
      if (typeof cost === "number") costUsd = (costUsd ?? 0) + cost
      const seen = attempt.outcome.streamSessionId
      if (seen !== "" && !sessions.includes(seen)) sessions.push(seen)
      return attempt
    }

    /**
     * Every spawn the call makes: counted whether or not it comes back, and its cost and session
     * recorded here if it does.
     *
     * Recording belongs to the spawn, not to whichever caller consumes it. When it belonged to the
     * callers, a corrective resume reached from a failing nudge passed through two of them and had
     * its cost added twice — `sessions` hid it, because the dedupe made the second call a no-op.
     * The run ledger's cost figures are load-bearing, so a cost that counts the same spawn twice is
     * not a cosmetic error.
     */
    const spawnAttempt = (request: Parameters<typeof spawnAndDecode>[1]): Effect.Effect<Attempt, TransportError> =>
      Effect.suspend(() => {
        attempts += 1
        return spawnAndDecode(deps, request).pipe(Effect.map(record))
      })

    const reply = (verdict: A, attempt: Attempt): ClaudeReply<A> => ({
      verdict,
      // The raw parsed line, not the decoded message: `Schema.Struct` drops undeclared keys, and
      // ten of the result message's real fields (`modelUsage`, `stop_reason`, `uuid` and the rest)
      // are undeclared here on purpose. The decode is the guard; this is the payload.
      result: attempt.outcome.resultLine,
      sessions,
      costUsd,
      attempts
    })

    const nullVerdict = (
      reason: "unparseable" | "error_max_structured_output_retries" | "decode-mismatch",
      session: string,
      shown: unknown
    ): TransportError => new NullVerdict({ reason, attempts, sessionId: session, snippet: snippet(shown) })

    // Each of the two resumes fires at most once, which bounds the call at three spawns: a first
    // spawn, a schemaless nudge, and a corrective resume for a nudge that itself failed.
    let correctiveUsed = false

    /**
     * One corrective resume against the session the failure named, falling back to the pin.
     *
     * `CLAUDE_USAGE_LIMIT` skips this outright. The resume is justified for a schema-validation
     * exit 1: the session holds a finished verdict, and one cheap `--resume` re-emits it. A usage
     * limit holds no finished verdict — the run never got that far — and the error itself already
     * carries the `resetAt` this resume would be retrying past. Spending a spawn on it is doomed
     * by definition, so unlike the schema-validation case, this one must not resume unconditionally.
     *
     * `CLAUDE_ENV_REQUIREMENT` skips this outright too, for a stronger reason than the usage limit:
     * the check runs before `Bun.spawn`, so no session exists to resume and the resume would fail
     * the same check on the same composed environment.
     */
    const corrective = (original: TransportError): Effect.Effect<Attempt, TransportError> =>
      Effect.gen(function* () {
        if (original._tag === "CLAUDE_USAGE_LIMIT" || original._tag === "CLAUDE_ENV_REQUIREMENT") {
          return yield* Effect.fail(original)
        }
        const resumeId = sessionIdOf(original) || pinned
        if (correctiveUsed || resumeId === "") return yield* Effect.fail(original)
        correctiveUsed = true
        return yield* spawnAttempt({
          ...base,
          prompt: CORRECTIVE_NUDGE_BRIEF,
          resume: resumeId,
          sessionId: undefined
        }).pipe(Effect.catch((second) => Effect.fail(preferIdle(original, second))))
      })

    /**
     * One schemaless nudge resume against a session that produced an unusable reply. A nudge that
     * fails outright takes the corrective resume, the same way the first spawn does: the session
     * holds finished work either way, and re-running the node costs dollars where a resume costs
     * cents.
     */
    const nudge = (session: string, shown: unknown): Effect.Effect<ClaudeReply<A>, TransportError> =>
      Effect.gen(function* () {
        if (correctiveUsed || session === "") {
          return yield* Effect.fail(nullVerdict("unparseable", session, shown))
        }
        const attempt = yield* spawnAttempt({
          ...base,
          prompt: NUDGE_BRIEF,
          resume: session,
          sessionId: undefined
        }).pipe(Effect.catch(corrective))

        // The same classification the first spawn's reply gets. A resume reaches the same API under
        // the same account, so a limit hit here is the same event; leaving it out made the tag
        // depend on which spawn the limit landed in, and a caller waiting on `resetAt` for a
        // `CLAUDE_USAGE_LIMIT` instead saw `CLAUDE_NULL_VERDICT` and re-ran straight into the spent
        // window.
        const failed = classify(attempt)
        if (failed !== null) return yield* Effect.fail(failed)

        const parsed = fromStructured(attempt.result) ?? parseResult(attempt.result.result)
        const nudgedSession = attempt.outcome.streamSessionId || session
        if (parsed === null) {
          return yield* Effect.fail(nullVerdict("unparseable", nudgedSession, attempt.result.result))
        }
        return reply(parsed as A, attempt)
      })

    /**
     * What a reply says went wrong before anyone tries to read a verdict out of it, or `null` when
     * nothing did. Every spawn's reply passes through this, whichever spawn it was.
     */
    const classify = (attempt: Attempt): TransportError | null => {
      const { outcome, result } = attempt
      const session = outcome.streamSessionId || pinned

      // The CLI has already retried with the validator's diagnostic in hand. Another spawn repeats
      // that work at full price.
      if (result.subtype === "error_max_structured_output_retries") {
        return nullVerdict("error_max_structured_output_retries", session, result.result)
      }

      // Only a failed run: a stray `api_retry` on a run that went on to succeed is a retry notice
      // the CLI recovered from, not a limit.
      return isFailedResult(result)
        ? asUsageLimit({
          apiErrorStatus: typeof result.api_error_status === "number" ? result.api_error_status : null,
          rateLimit: outcome.rateLimit,
          stderrTail: outcome.stderrTail
        }, session)
        : null
    }

    const resolve = (attempt: Attempt): Effect.Effect<ClaudeReply<A>, TransportError> => {
      const { outcome, result } = attempt
      const session = outcome.streamSessionId || pinned

      const failed = classify(attempt)
      if (failed !== null) return Effect.fail(failed)

      const schema = request.jsonSchema
      if (schema !== undefined) {
        return schema.decode(result.structured_output).pipe(
          Effect.map((verdict) => reply(verdict, attempt)),
          Effect.mapError(() => nullVerdict("decode-mismatch", session, result.structured_output ?? result.result))
        )
      }

      const parsed = fromStructured(result) ?? parseResult(result.result)
      return parsed === null ? nudge(session, result.result) : Effect.succeed(reply(parsed as A, attempt))
    }

    const first = yield* spawnAttempt(base).pipe(Effect.catch(corrective))
    return yield* resolve(first)
  })

/**
 * The live service. `ClaudeBin` and `Heartbeat` are `Context.Reference`s, so reading them here
 * leaves `prompt`'s requirement channel at `never` and any node holding this service registrable.
 */
export const liveClaudeAgent: ClaudeAgentService = {
  prompt: <A>(request: ClaudePrint<A>): Effect.Effect<ClaudeReply<A>, TransportError> =>
    Effect.gen(function* () {
      const bin = yield* ClaudeBin
      const heartbeat = yield* Heartbeat
      const timing = yield* ClaudeTiming
      const isolated = yield* ClaudeIsolation
      return yield* promptWith(
        {
          bin,
          timing,
          beat: (sessionId, beatEpochSecs) => heartbeat.beat(sessionId, beatEpochSecs),
          now: () => Date.now(),
          newSessionId: () => crypto.randomUUID(),
          isolated
        },
        request
      )
    })
}
