import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { graph } from "mag/runtime/graph"
import { type RootEnv, RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { RunId } from "mag/runtime/trace/layer"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { when } from "mag/runtime/when"

/**
 * A fixture host graph composes a fixture subgraph — the subgraph's own file (this fixture stands
 * in for one) is imported and run as-is, with no wrapper at the borrowing site. The subgraph
 * guards one node with `when`, so the same fixture proves both a plain composed node
 * (`fixtureHostNode`, `fixtureProbe`) and the disconfirming skip (`fixtureGuarded`) in one run.
 */

const fixtureHostNode = make({
  name: "fixture-host-node",
  description: "A plain node living directly in the host's own pipeline.",
  input: Schema.Struct({}),
  success: Schema.Struct({ marker: Schema.String }),
  run: () => Effect.succeed({ marker: "host-ran" })
})

const fixtureProbe = make({
  name: "fixture-probe",
  description: "Returns whatever verdict the test drives through the run's own input.",
  input: Schema.Struct({ matched: Schema.Boolean }),
  success: Schema.Struct({ matched: Schema.Boolean }),
  run: (input) => Effect.succeed({ matched: input.matched })
})

const fixtureGuarded = make({
  name: "fixture-guarded",
  description: "The guarded node: its journal row is the evidence of whether it was entered.",
  input: Schema.Struct({}),
  success: Schema.Struct({ ran: Schema.Boolean }),
  run: () => Effect.succeed({ ran: true })
})

const fixtureSubgraph = graph({
  name: "fixture-subgraph",
  description: "Guards one node behind a probe whose verdict the run's own input carries.",
  input: Schema.Struct({ ticket: Schema.String, matched: Schema.Boolean }),
  success: Schema.Struct({ guardedRan: Schema.Boolean }),
  // Inert while composed beneath fixtureHost: RunScoped is already set by then (run-layers.ts).
  scope: (input) => ({ ticket: input.ticket, graph: "fixture-subgraph", worktree: false }),
  pipeline: (input) =>
    Effect.gen(function* () {
      const guarded = yield* when(fixtureProbe, fixtureGuarded)({ probe: { matched: input.matched }, node: {} })
      return { guardedRan: Option.isSome(guarded) }
    })
})

const fixtureHost = graph({
  name: "fixture-host",
  description: "Composes fixtureSubgraph as one node among its own.",
  input: Schema.Struct({ ticket: Schema.String, matched: Schema.Boolean }),
  success: Schema.Struct({ marker: Schema.String, guardedRan: Schema.Boolean }),
  scope: (input) => ({ ticket: input.ticket, graph: "fixture-host", worktree: false }),
  pipeline: (input) =>
    Effect.gen(function* () {
      const step = yield* fixtureHostNode.run({})
      const sub = yield* fixtureSubgraph.run({ ticket: input.ticket, matched: input.matched })
      return { marker: step.marker, guardedRan: sub.guardedRan }
    })
})

const RUN_ID = "20260822090000-c0de"
const REPO_ROOT = "/repo/fixture"

const gitShell = (): ShellService => ({
  run: (argv): Effect.Effect<ShellResult> => {
    // run-layers.ts's identity check — same answer on both sides keeps every run here a home run.
    if (argv.includes("--git-common-dir")) return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}/.git\n`, stderr: "" })
    if (argv.includes("--show-toplevel")) return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}\n`, stderr: "" })
    if (argv.includes("HEAD")) return Effect.succeed({ exitCode: 0, stdout: "abc123\n", stderr: "" })
    throw new Error(`gitShell: unexpected argv ${argv.join(" ")}`)
  }
})

const tempRoot = (): RootEnv => ({
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "graph-composition-")) },
  home: "/unused"
})

/** Runs `fixtureHost` end to end and returns its success plus every journal row's `node` name. */
const runHost = async (ticket: string, matched: boolean) => {
  const root = tempRoot()
  const success = await Effect.runPromise(
    fixtureHost.run({ ticket, matched }).pipe(
      Effect.provideService(RunRootEnv, root),
      Effect.provideService(RunId, RUN_ID),
      Effect.provide(shellLayer(gitShell()))
    )
  )
  const path = journalPathFor({ ...root, repoPath: REPO_ROOT, ticket, runId: RUN_ID })
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly node: string; readonly runId: string; readonly graph: string })
  return { success, rows }
}

describe("graph composition", () => {
  test("a subgraph composes as one node — the host's success carries the subgraph's, and one journal covers both", async () => {
    const { success, rows } = await runHost("GH-286-ac01", true)

    expect(success).toEqual({ marker: "host-ran", guardedRan: true })

    const names = rows.map((row) => row.node)
    expect(names).toContain("fixture-host-node") // the host's own node
    expect(names).toContain("fixture-subgraph") // the subgraph itself, journalled as one node
    expect(names).toContain("fixture-probe") // the subgraph's own node
    expect(names).toContain("fixture-guarded") // the subgraph's own node, matched: true

    // Every row shares one run: the composition mints no second scope (run-layers.ts's `RunScoped`).
    expect(rows.every((row) => row.runId === RUN_ID)).toBe(true)
    expect(rows.every((row) => row.graph === "fixture-host")).toBe(true)
  })

  test("disconfirming: a skipped condition leaves no journal row for the guarded node", async () => {
    const { success, rows } = await runHost("GH-286-ac03", false)

    expect(success).toEqual({ marker: "host-ran", guardedRan: false })

    const names = rows.map((row) => row.node)
    expect(names).toContain("fixture-probe") // the probe still ran and was journalled
    expect(names).not.toContain("fixture-guarded") // never entered, at any attempt
  })
})
