import { Context, Data, Effect, Layer } from "effect"

/**
 * The `Shell` service: run a real subprocess, get its real exit code back.
 *
 * Deliberately smaller than a general process API. It runs an argv, captures both streams, and
 * reports what the process did. It has no shell interpolation (the argv is a list, never a string,
 * so quoting is not a concern that exists here), no streaming, no stdin, and no notion of a
 * "successful" exit code — a non-zero exit is a *result*, not a failure, because the callers that
 * need one need to tell exit 2 from exit 3. Widen it when a node actually needs more.
 */

export interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ShellOptions {
  readonly cwd?: string
}

export interface ShellService {
  readonly run: (
    argv: readonly [string, ...string[]],
    options?: ShellOptions
  ) => Effect.Effect<ShellResult, CommandNotExecutable>
}

/**
 * The process never started: the binary is missing, is not executable, or the working directory
 * does not exist. Distinct from "it ran and exited non-zero", which is an ordinary {@link ShellResult}.
 */
export class CommandNotExecutable extends Data.TaggedError("SHELL_COMMAND_NOT_EXECUTABLE")<{
  readonly argv: string
  readonly detail: string
}> {}

const decoder = new TextDecoder()

const readStream = async (stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> =>
  stream === undefined || typeof stream === "number" ? "" : decoder.decode(await Bun.readableStreamToBytes(stream))

/**
 * `Bun.spawn` rather than `@effect/platform`'s `CommandExecutor`: bun runs this repo, the whole
 * surface needed is "argv in, exit code and two strings out", and keeping it here means the
 * capability arrives through one small seam instead of a platform dependency reaching every node.
 * If a node ever needs streaming or stdin, that is the moment to reconsider, not before.
 */
export const liveShell: ShellService = {
  run: (argv, options) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(argv as unknown as string[], {
          cwd: options?.cwd,
          stdout: "pipe",
          stderr: "pipe"
        })
        const [stdout, stderr] = await Promise.all([readStream(child.stdout), readStream(child.stderr)])
        const exitCode = await child.exited
        return { exitCode, stdout, stderr }
      },
      catch: (cause) =>
        new CommandNotExecutable({
          argv: argv.join(" "),
          detail: cause instanceof Error ? cause.message : String(cause)
        })
    })
}

/**
 * A `Context.Reference`, matching `trace/sink.ts`'s `TraceSinks` and `trace/layer.ts`'s `RunId`:
 * every custom service in this codebase resolves from a default rather than failing when nothing
 * is provided. That is what keeps a node's `R` channel at `never` — which `runtime/types.ts` pins
 * for anything reachable from the CLI — while still leaving the implementation swappable, since
 * providing {@link shellLayer} with a different `ShellService` overrides the default.
 */
export const Shell = Context.Reference<ShellService>("mag/runtime/Shell", {
  defaultValue: () => liveShell
})

/** Provide a specific `ShellService` — a recorded or in-memory one in tests, the live one in prod. */
export const shellLayer = (service: ShellService): Layer.Layer<never> => Layer.succeed(Shell, service)
