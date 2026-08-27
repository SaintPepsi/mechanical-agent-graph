import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, type Layer } from "effect"
import { Command } from "effect/unstable/cli"
import pkg from "mag/package.json" with { type: "json" }
import { buildCli } from "mag/runtime/build-cli"
import { platformRefusal } from "mag/runtime/platform"
import { renderFailure, renderRefusal, withStdoutRouting } from "mag/runtime/render"
import { tracingLayer } from "mag/runtime/trace/layer"
import type { Registry } from "mag/runtime/types"

/**
 * Composition only: fold the registry into the root command, run it through `render.ts`'s
 * `withStdoutRouting` (keeps v4's usage-doc prose off stdout on failure), and
 * route any remaining failure (node failure, build failure, or a re-raised `effect/unstable/cli`
 * `CliError`) through `renderFailure`. `buildCli`, `withStdoutRouting` and `renderFailure` carry
 * every body; this is only the glue.
 *
 * Argv is not a parameter: v4's `Command.run` takes its arguments from the `Stdio` service, whose
 * Node implementation already reads `process.argv.slice(2)` (`@effect/platform-node-shared`'s
 * `NodeStdio.layer`). The layer is the argv boundary now, so `main` provides `NodeServices.layer`
 * and nothing here touches `process.argv`.
 *
 * `Effect.catch` only sees the error channel — an unhandled throw inside a node's `run` (or
 * anywhere else in this pipeline) is a defect, not a failure, and passes straight through it.
 * `Effect.catchDefect` catches that separately and routes it through the same `renderFailure`,
 * so a raw throw still exits 1 with a non-empty stderr line instead of exiting silently.
 *
 * The `as Command.Command<...>` below is the one deliberate type-erasure boundary in
 * `src/runtime/`: a runtime-heterogeneous registry cannot carry each command's precise
 * Input/E/R params without existential types, which TypeScript lacks. `AnyCommand`'s params are
 * `any` for the fold in build-cli.ts, but every command actually reaching this point is built from
 * either a `CommandNode` (pinned `R = never` by `types.ts`) or a bare `Command.make` group (also
 * `R = E = never`) — so re-asserting R here is narrowing back to the true,
 * structurally-guaranteed type, not discarding information. The parameters are v4's
 * `Command<Name, Input, ContextInput, E, R>`, positionally: the load-bearing one is the last,
 * `R = never`. `Input` is contravariant (`Command.Variance`'s `Contravariant<Input>`), so `unknown`
 * — not `never` — is the narrowing end of that slot, and `Command.run` does not read it at all.
 * Without the cast, `any` poisons the effect's requirement channel and
 * `Effect.provide(NodeServices.layer)` in `main` can no longer reduce it to `never`, which
 * `NodeRuntime.runMain` requires.
 */
export const runCli = (registry: Registry) =>
  buildCli(registry).pipe(
    Effect.flatMap((command) =>
      withStdoutRouting(
        Command.run(command as Command.Command<string, unknown, unknown, unknown, never>, {
          version: pkg.version,
        })
      )
    ),
    Effect.catch(renderFailure),
    Effect.catchDefect(renderFailure),
  )

/**
 * Shared entry-point shape for `src/cli.ts` and the seven `test/harness-cli*.ts` harnesses: provide `NodeServices.layer` —
 * the aggregate Node platform layer (child-process spawner, crypto, filesystem, path, stdio,
 * terminal) that supplies every service in `Command.Environment`, argv included — and hand the
 * whole thing to `runMain`.
 *
 * `tracing` is the entry seam a person composes sink layers at — a defaulted second
 * parameter, not a second exported entry, so a call site with nothing to say about sinks
 * (`src/cli.ts`, `test/harness-cli.ts`, `test/harness-cli-unsupported.ts`) calls `main(registry)` and
 * picks up the default, always-on `tracingLayer` (console sink only), while the four harnesses that
 * do (`harness-cli-tracing`, `-no-sink`, `-broken-sink`, `-nested`) pass one.
 *
 * `platform` is checked before anything else, including `runMain` itself — a
 * refused platform never builds a layer, parses argv, or touches the filesystem. Like `tracing`,
 * it is a defaulted third parameter (not a flag, not an env var) so a test hands it `"win32"`
 * without mutating the real `process.platform`.
 */
export const main = (
  registry: Registry,
  tracing: Layer.Layer<never> = tracingLayer,
  platform: string = process.platform
): void => {
  const refusal = platformRefusal(platform)
  if (refusal !== undefined) {
    renderRefusal(refusal)
    return
  }

  NodeRuntime.runMain(runCli(registry).pipe(Effect.provide(tracing), Effect.provide(NodeServices.layer)), {
    disableErrorReporting: true,
  })
}
