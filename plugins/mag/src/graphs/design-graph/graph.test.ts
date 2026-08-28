import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { designGraph } from "mag/graphs/design-graph/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { graph } from "mag/runtime/graph"
import { make } from "mag/runtime/graph-node.definition"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type RootEnv, RunRootEnv, RunScoped } from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { RunId } from "mag/runtime/trace/layer"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, withForeignRepo } from "mag/test/node-fixture"

const RUN_ID = "20260823120000-de51"
const TICKET = "## Executive Summary\n\nTwo notations."
/** Stands in for `fetch-ticket`'s own write: the graph reads the ticket from disk, so every run gets a real file. */
const inputWith = (repoRoot: string) => {
  const ticketPath = join(repoRoot, "ticket.md")
  writeFileSync(ticketPath, TICKET)
  return { ticket: "GH-288", title: "Envision and build the design graph", ticketPath }
}

/**
 * Routes a `ClaudePrint` to its writer by the one marker string unique to each dispatching node's
 * own prompt text — `BLIND_DRAW_RULE` (`skills/envision/notation.ts`, which `envision-notation`
 * compiles), `discover`'s recon line and `brainstorm`'s citation line (each verbatim in its own
 * `graph-node.ts`). Cheaper than threading a fourth channel through the stub, and it doubles as a
 * structural check: a route can only be told apart by text its own node actually composed.
 */
const routeOf = (prompt: string): "envision" | "discover" | "recycle" | "brainstorm" => {
  if (prompt.includes("Draw the ideal shape")) return "envision"
  if (prompt.includes("Recon this repository")) return "discover"
  if (prompt.includes("Map what this ticket can reuse")) return "recycle"
  if (prompt.includes("Read each vision below")) return "brainstorm"
  throw new Error(`stub agent: unrecognised route in prompt: ${prompt.slice(0, 120)}`)
}

/** Extracts the backticked path `envision-notation`/`discover`/`brainstorm` each spliced into their own prompt. */
const destinationOf = (prompt: string, marker: string): string => {
  const match = prompt.match(new RegExp(`${marker} \`([^\`]+)\``))
  if (match === null || match[1] === undefined) throw new Error(`no destination for "${marker}" in prompt`)
  return match[1]
}

/**
 * A stub `ClaudeAgent` for the whole graph: every dispatching node's own destination convention
 * writes a real file at the path the node itself computed and echoes it back in the verdict — the
 * dispatch spine every node in this graph shares, `envision-notation`'s own doc comment. `brainstorm`
 * backtick-quotes its own computed destination the same way, so all three routes are proven the same
 * way: parsed from the prompt the node actually sent, never a path the test computed itself and
 * handed in from outside.
 */
const stubAgent = (): { readonly requests: Array<ClaudePrint<unknown>>; readonly service: ClaudeAgentService } => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const route = routeOf(request.prompt)

      if (route === "envision") {
        const destination = destinationOf(request.prompt, "Write the vision to")
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, "graph TD\n  A --> B\n")
        return Effect.succeed(
          { verdict: { visionPath: destination } as A, result: {}, sessions: [`session-${destination}`], costUsd: 0.1, attempts: 1 } as ClaudeReply<A>
        )
      }

      if (route === "discover") {
        const destination = destinationOf(request.prompt, "Write your findings to")
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, "# Discover\n\nNothing relevant found.\n")
        return Effect.succeed(
          { verdict: { discoverPath: destination } as A, result: {}, sessions: ["session-discover"], costUsd: 0.2, attempts: 1 } as ClaudeReply<A>
        )
      }

      if (route === "recycle") {
        const destination = destinationOf(request.prompt, "Write the map to")
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, "# Recycle map\n\nNothing to reuse.\n")
        return Effect.succeed(
          { verdict: { recycleMapPath: destination } as A, result: {}, sessions: ["session-recycle"], costUsd: 0.1, attempts: 1 } as ClaudeReply<A>
        )
      }

      const destination = destinationOf(request.prompt, "Write the design doc to")
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, "# Design\n\n## Vision Reconciliation\n\nNo collisions.\n")
      return Effect.succeed(
        { verdict: { designPath: destination } as A, result: {}, sessions: ["session-brainstorm"], costUsd: 0.3, attempts: 1 } as ClaudeReply<A>
      )
    }
  }
  return { requests, service }
}

/** Answers every git read the run makes (`--show-toplevel`, `rev-parse HEAD`) and succeeds silently
 * on anything else. Under the default `run-root` policy no record is committed at all, so this stub
 * only has to be order-independent — concurrent dispatch across the graph's nodes makes call order
 * nondeterministic, `envision-visions`' own `alwaysCommits` precedent. */
const gitShell = (repoRoot: string): ShellService => ({
  run: (argv): Effect.Effect<ShellResult> => {
    if (argv.includes("--show-toplevel")) return Effect.succeed({ exitCode: 0, stdout: `${repoRoot}\n`, stderr: "" })
    if (argv[1] === "rev-parse" && argv[2] === "HEAD") return Effect.succeed({ exitCode: 0, stdout: "abc123def4567890abc123def4567890abcdef1\n", stderr: "" })
    if (argv[1] === "diff") return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
  }
})

const tempRoot = (): RootEnv => ({
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "design-graph-root-")) },
  home: "/unused"
})

const withRepo = async <T>(fn: (repoRoot: string) => Promise<T>): Promise<T> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "design-graph-repo-"))
  try {
    return await fn(repoRoot)
  } finally {
    await removeDir(repoRoot)
  }
}

/** Declares `svelte` and `effect` as dependencies, so the three mechanical probes match both — the
 * multi-stack case, no `graph-core` (the probe checks this repository's own name, not
 * a dependency, and a fixture repo carries neither). */
const writeMultiStackManifest = (repoRoot: string) =>
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture-target", dependencies: { svelte: "^5", effect: "^4" } }))

const runDesignGraph = (repoRoot: string, root: RootEnv, agent: ClaudeAgentService) =>
  Effect.runPromise(
    designGraph.run(inputWith(repoRoot)).pipe(
      Effect.provideService(RunRootEnv, root),
      Effect.provideService(RunId, RUN_ID),
      Effect.provide(shellLayer(gitShell(repoRoot))),
      Effect.provide(claudeAgentLayer(agent))
    )
  )

/** One row per node run, not two: `journaled` (`journal/journaled.ts`) appends a "start" and an
 * "end" entry per attempt, and only the end row is this helper's concern — a node run's
 * outcome, once, the same count `journal.attempt` itself would report. */
const journalRows = (root: RootEnv, repoRoot: string, ticket: string) => {
  const path = journalPathFor({ ...root, repoPath: repoRoot, ticket, runId: RUN_ID })
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly node: string; readonly runId: string; readonly graph: string; readonly event: string })
    .filter((row) => row.event === "end")
}

describe("design-graph", () => {
  test("a multi-stack run probes before dispatch, produces one vision per matched notation, and journals a row per node", () =>
    withRepo(async (repoRoot) => {
      writeMultiStackManifest(repoRoot)
      const root = tempRoot()
      const agent = stubAgent()

      const success = await runDesignGraph(repoRoot, root, agent.service)

      // The notation list came from the probes, run before any dispatch (`resolveNotations` sits
      // between them and `envisionVisions` in the pipeline) — svelte and effect matched, so exactly
      // those two visions exist, neither the generic fallback nor graph-core.
      expect(success.visionPaths).toHaveLength(2)
      expect(success.visionPaths.some((path) => path.includes("vision-svelte.md"))).toBe(true)
      expect(success.visionPaths.some((path) => path.includes("vision-effect.md"))).toBe(true)
      for (const path of success.visionPaths) expect(readFileSync(path, "utf8").length).toBeGreaterThan(0)

      expect(success.discoverPath).toBe(`${repoRoot}/docs/graph/GH-288/discover.md`)
      expect(readFileSync(success.discoverPath, "utf8").length).toBeGreaterThan(0)
      expect(success.recycleMapPath).toBe(`${repoRoot}/docs/graph/GH-288/recycle-map.md`)
      expect(readFileSync(success.recycleMapPath, "utf8").length).toBeGreaterThan(0)

      expect(success.designPath).toBe(join(repoRoot, "docs", "graph", "GH-288", "design.md"))
      expect(readFileSync(success.designPath, "utf8")).toContain("## Vision Reconciliation")
      expect(success.headSha).toBe("abc123def4567890abc123def4567890abcdef1")

      expect(success.sessions.length).toBeGreaterThan(0)
      expect(success.costUsd).not.toBeNull()

      // `design-graph`'s own row is never recorded when it is the run's root: its journaled wrapper
      // needs the very Journal its own `runScopedLayers` call builds, a chicken-and-egg gap
      // `graph-composition.test.ts` already lives with (it never asserts `fixture-host`
      // appears, only the host's children and the composed subgraph). Only a graph composed BENEATH
      // another graph's scope gets its own row, the same test's `fixture-subgraph` entry.
      const names = journalRows(root, repoRoot, "GH-288").map((row) => row.node)
      for (const name of ["detect-svelte", "detect-effect", "detect-graph-core", "resolve-notations", "envision-visions", "discover", "recycle-map", "assemble-brainstorm-prompt", "brainstorm"]) {
        expect(names).toContain(name)
      }
      // envision-visions fans out one envision-notation row per matched notation.
      expect(names.filter((name) => name === "envision-notation")).toHaveLength(2)
    }))

  test("envision and discover dispatch concurrently, and neither request carries the other's output", () =>
    withRepo(async (repoRoot) => {
      // No manifest anywhere: `notationsFor([])` answers the generic fallback (`envisioning.ts`), one vision.
      const root = tempRoot()
      const agent = stubAgent()

      await runDesignGraph(repoRoot, root, agent.service)

      const envisionRequests = agent.requests.filter((r) => routeOf(r.prompt) === "envision")
      const discoverRequests = agent.requests.filter((r) => routeOf(r.prompt) === "discover")
      expect(envisionRequests).toHaveLength(1)
      expect(discoverRequests).toHaveLength(1)

      // Structural: envision's input schema carries no discover-note field and vice versa —
      // neither prompt can quote text only the other node's own dispatch composed.
      expect(envisionRequests[0]!.prompt).not.toContain("Recon this repository")
      expect(discoverRequests[0]!.prompt).not.toContain("Draw the ideal shape")
      // Neither carries the ticket's text: every route cites the file by path.
      for (const request of agent.requests) expect(request.prompt).not.toContain("Two notations.")
    }))

  // `graph.ts` keeps `scope` a constructor argument rather than a field, so the only way to read
  // `records` back is the run it produced: under `"committed"` every record write also commits
  // (`records.ts`'s own policy gate), which the default `"run-root"` policy never does. The field's
  // own check is what refuses anything but the two values, at decode.
  test("records: \"committed\" is accepted and reaches the scope; an unlisted value is refused at decode", () =>
    withRepo(async (repoRoot) => {
      if (!isSchemaHandle(designGraph.input)) throw new Error("designGraph.input is not a Schema")
      const decode = Schema.decodeUnknownSync(designGraph.input)
      const INPUT = inputWith(repoRoot)
      expect(decode({ ...INPUT, records: "committed" })).toMatchObject({ records: "committed" })
      expect(() => decode({ ...INPUT, records: "archived" })).toThrow()

      const calls: string[][] = []
      const git = gitShell(repoRoot)
      const service: ShellService = {
        run: (argv, options) => {
          calls.push([...argv])
          return git.run(argv, options)
        }
      }
      const agent = stubAgent()

      await Effect.runPromise(
        designGraph.run({ ...INPUT, records: "committed" }).pipe(
          Effect.provideService(RunRootEnv, tempRoot()),
          Effect.provideService(RunId, RUN_ID),
          Effect.provide(shellLayer(service)),
          Effect.provide(claudeAgentLayer(agent.service))
        )
      )

      expect(calls.some((argv) => argv[1] === "commit")).toBe(true)
    }))

  test("a fixture host graph composes design-graph as one node, one journal covers both", () =>
    withRepo(async (repoRoot) => {
      const root = tempRoot()
      const agent = stubAgent()

      const hostNode = make({
        name: "fixture-host-node",
        description: "A plain node living directly in the host's own pipeline, ahead of the composed subgraph.",
        input: Schema.Struct({}),
        success: Schema.Struct({ marker: Schema.String }),
        run: () => Effect.succeed({ marker: "host-ran" })
      })

      const host = graph({
        name: "fixture-host",
        description: "Composes designGraph as one node among its own, unedited.",
        input: Schema.Struct({ ticket: Schema.String, title: Schema.String, ticketPath: Schema.String }),
        success: Schema.Struct({ marker: Schema.String, designPath: Schema.String }),
        scope: (input) => ({ ticket: input.ticket, graph: "fixture-host", worktree: false }),
        pipeline: (input) =>
          Effect.gen(function* () {
            const step = yield* hostNode.run({})
            const sub = yield* designGraph.run(input)
            return { marker: step.marker, designPath: sub.designPath }
          })
      })

      const success = await Effect.runPromise(
        host.run(inputWith(repoRoot)).pipe(
          Effect.provideService(RunRootEnv, root),
          Effect.provideService(RunId, RUN_ID),
          Effect.provide(shellLayer(gitShell(repoRoot))),
          Effect.provide(claudeAgentLayer(agent.service))
        )
      )

      expect(success.marker).toBe("host-ran")
      expect(success.designPath).toBe(join(repoRoot, "docs", "graph", "GH-288", "design.md"))

      const rows = journalRows(root, repoRoot, "GH-288")
      const names = rows.map((row) => row.node)
      expect(names).toContain("fixture-host-node")
      expect(names).toContain("design-graph")
      expect(names).toContain("brainstorm")

      // Composition mints no second scope (`RunScoped`, run-layers.ts): every row shares one run and
      // is stamped with the HOST's own graph name, `design-graph` composed in exactly the way
      // graph-composition.test.ts asserts of its own fixture subgraph.
      expect(rows.every((row) => row.runId === RUN_ID)).toBe(true)
      expect(rows.every((row) => row.graph === "fixture-host")).toBe(true)
    }))

  /** Records every git call and succeeds on all of them; under the default `run-root` policy the
   *  run commits nothing, so the recorded calls are the reads alone. */
  const trackedShell = (): { readonly calls: Array<{ readonly argv: readonly string[]; readonly cwd: string | undefined }>; readonly service: ShellService } => {
    const calls: Array<{ readonly argv: readonly string[]; readonly cwd: string | undefined }> = []
    const service: ShellService = {
      run: (argv, options): Effect.Effect<ShellResult> => {
        calls.push({ argv, cwd: options?.cwd })
        if (argv[1] === "diff") return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
        if (argv[1] === "rev-parse" && argv[2] === "HEAD") {
          return Effect.succeed({ exitCode: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", stderr: "" })
        }
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
      }
    }
    return { calls, service }
  }

  /**
   * Tested once, structurally: a `RunInfo` whose `recordsRoot` sits outside `workRoot` —
   * `RunScoped: true` bypasses `runScopedLayers`'s own git discovery, so the fixture states the
   * placement directly instead of faking the two-repository probe. The default `records: "run-root"`
   * policy, `withForeignRepo`'s own shape: a foreign run keeps `recordsRoot` a disposable temp
   * directory distinct from `workRoot` only under this policy — `records: "committed"` keeps the two
   * equal instead (`run-layers.ts`'s own same-tree rule), so there is nothing left to separate under
   * that policy. Every path this graph's success carries has to fall under `recordsRoot`; none may
   * fall under `workRoot`, the property `recordPath`/`recordsDir` being the only composer is supposed
   * to hold. `headSha`'s own `git rev-parse HEAD` is the one call this graph makes under this policy —
   * nothing commits, so `brainstorm`'s rev-parse is the whole of `calls` — and it reads at `workRoot`
   * (`workdir(runInfo)`, `brainstorm/graph-node.ts`), meaningful under every records policy:
   * `recordsRoot` is a plain OS temp directory with no git repository of its own here, so `recordsRoot`
   * cannot answer it.
   */
  test("once, structurally: every record write lands under recordsRoot, and headSha alone reads under workRoot", () =>
    withForeignRepo("design-graph", async (workRoot, recordsRoot, run) => {
      const agent = stubAgent()
      const { calls, service } = trackedShell()

      const success = await Effect.runPromise(
        designGraph.run(inputWith(workRoot)).pipe(
          Effect.provideService(RunScoped, true),
          Effect.provideService(RunInfo, run),
          Effect.provide(shellLayer(service)),
          Effect.provide(claudeAgentLayer(agent.service))
        )
      )

      for (const path of [...success.visionPaths, success.discoverPath, success.recycleMapPath, success.designPath]) {
        expect(path.startsWith(recordsRoot)).toBe(true)
        expect(path.startsWith(workRoot)).toBe(false)
      }

      const headShaCalls = calls.filter((call) => call.argv[1] === "rev-parse" && call.argv[2] === "HEAD")
      expect(headShaCalls.length).toBeGreaterThan(0)
      for (const call of headShaCalls) expect(call.cwd).toBe(workRoot)
      // Nothing commits under the default policy — the rev-parse reads above are every call this
      // graph makes, so no record write ever reaches a git call to check the cwd of.
      expect(calls.length).toBe(headShaCalls.length)
    }))
})
