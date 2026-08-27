import { Cause, Console, Effect, Exit, Option, Schema, Struct } from "effect"
import { CliError } from "effect/unstable/cli"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { REFUSED_EXIT_CODE, type PlatformRefusal } from "mag/runtime/platform"
import { UNTAGGED_FAILURE } from "mag/runtime/trace/outcome"

/** Structural guard for "an object whose fields we can inspect" — narrowing, not asserting. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * Pure formatter for a failed GraphNode/decode error. One line, no trailing
 * newline. Rule, in order: the error's `_tag` when present, then its
 * `message` when that is a non-empty string, otherwise compact JSON of the
 * error's own enumerable fields (excluding `_tag`). Falls back to a stable
 * non-empty line when the error carries neither.
 */
export const formatFailure = (error: unknown): string => {
  const record = isRecord(error) ? error : undefined

  const tag = record !== undefined && typeof record["_tag"] === "string" ? record["_tag"] : undefined
  const message = record !== undefined && typeof record["message"] === "string" && record["message"].length > 0
    ? record["message"]
    : undefined

  if (tag !== undefined && message !== undefined) {
    return `${tag}: ${message}`
  }

  if (tag !== undefined) {
    const fields = record ? Struct.omit(record, ["_tag"]) : {}
    return `${tag}: ${JSON.stringify(fields)}`
  }

  if (message !== undefined) {
    return message
  }

  return `${UNTAGGED_FAILURE}: an unrecognised error occurred`
}

/**
 * Encode a GraphNode's success value against its `success` schema, then
 * write exactly one JSON line to stdout. `process.stdout` is written here and
 * nowhere else in `src/runtime/`; the only other process-level writers are
 * this file's own stderr paths, `trace/console-sink.ts` (`process.stderr`)
 * and `trace/file-sink.ts` (`node:fs`).
 */
export const renderSuccess = <I, A, E, R>(node: GraphNode<I, A, E, R>, value: A) =>
  Schema.encodeEffect(node.success)(value).pipe(
    Effect.map((encoded) => {
      process.stdout.write(`${JSON.stringify(encoded)}\n`)
    }),
  )

/**
 * Render a failed Effect run. `effect/unstable/cli` CLI errors (missing
 * required flag, unknown command, `--help`) are re-raised unchanged so the
 * library renders its own usage `HelpDoc` rather than being flattened into
 * one line — the honest error channel below is that re-raise. Every other
 * error is formatted by `formatFailure` and written to stderr, and the
 * process exit code is set to 1.
 *
 * The `process.stderr` write and `process.exitCode` mutation here are the
 * failure half of this file's process boundary (see `renderSuccess`). They
 * stay direct on purpose: `NodeRuntime.runMain` does not call `process.exit`
 * when the effect succeeds, so a mutated `exitCode` survives to natural exit
 * as exit 1, and `main` in run-cli.ts sets `disableErrorReporting` so
 * nothing double-prints. An embedder wanting different sinks embeds `runCli`
 * plus its own renderers, not this pair.
 */
export const renderFailure = (error: unknown): Effect.Effect<void, CliError.CliError> => {
  if (CliError.isCliError(error)) {
    return Effect.fail(error)
  }

  return Effect.sync(() => {
    process.stderr.write(`${formatFailure(error)}\n`)
    process.exitCode = 1
  })
}

/**
 * Fires before `NodeRuntime.runMain` is ever called, so unlike `renderFailure` there is no effect
 * to fail and no `disableErrorReporting` to coordinate with: `process.exitCode` alone carries the
 * outcome to natural exit.
 */
export const renderRefusal = (refusal: PlatformRefusal): void => {
  process.stderr.write(`${refusal.detail}\n${refusal.hint}\n`)
  process.exitCode = REFUSED_EXIT_CODE
}

/**
 * `effect/unstable/cli`'s `Command.run` prints its usage doc via `Console` even on failure, where
 * its prior major version stayed silent. Buffers every `Console.log` line and flushes it to stdout
 * on success or a bare `--help` (`ShowHelp` with empty `errors`), stderr
 * otherwise — keeping stdout empty when the command fails. Re-propagates the original exit unchanged.
 */
export const withStdoutRouting = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const buffered: Array<string> = []
  const capturingConsole: Console.Console = Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => buffered.push(`${args.join(" ")}\n`),
  })
  const isBareHelp = (exit: Exit.Exit<unknown, unknown>): boolean => {
    if (Exit.isSuccess(exit)) return false
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    return CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0
  }
  return effect.pipe(
    Effect.provideService(Console.Console, capturingConsole),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (buffered.length === 0) return
        const stream = Exit.isSuccess(exit) || isBareHelp(exit) ? process.stdout : process.stderr
        stream.write(buffered.join(""))
      })
    ),
  )
}
