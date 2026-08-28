import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, FileSystem, type Option, Schema } from "effect"
import type { ClaudeAgentService, ClaudePrint, ClaudeReply } from "mag/runtime/claude/service"
import { execute, make } from "mag/runtime/graph-node.definition"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { journalLayer } from "mag/runtime/journal/service"
import { platform } from "mag/runtime/platform"
import type { RunInfoService } from "mag/runtime/run-info"
import type { ShellResult, ShellService } from "mag/runtime/shell"

/** One node's on-disk shape for a fixture: a name plus verbatim file contents. */
export interface NodeSpec {
  readonly name: string
  readonly files: Readonly<Record<string, string>>
  readonly directories?: readonly string[]
}

/** `root` is the graph-nodes root to pass to `--root`; `cleanup` removes the whole temp tree above it. */
export interface Fixture {
  readonly root: string
  readonly cleanup: () => void
}

/**
 * Was copied verbatim into three node tests (`build`, `analyse-reviews`, `discover`)
 * before being promoted here — a shared seam applies just as much to a test helper as to
 * runtime code (PRINCIPLES.md, "A blocked sibling import promotes the helper to `mag/runtime/`;
 * it never copies it."). Deletes a fixture directory, and only a fixture directory: anything
 * outside tmpdir is refused.
 */
export const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

/** A real, disposable run root for a node whose dispatch writes an artifact into it. `prefix` names the temp dir after the node under test. */
export const withRunRoot = async <T>(prefix: string, fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), `${prefix}-`))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

/** In-order scripted shell: one canned reply per call, recording every argv; an unscripted call throws. */
export const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: string[][] = []
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

/** Records every prompt dispatched, whatever the node asks for, answering one canned reply generalised to any verdict shape. */
export const recordingAgent = () => {
  const prompts: string[] = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      prompts.push(request.prompt)
      return Effect.succeed({
        verdict: { summary: "did the work", visionPath: "ignored", blocking: [] } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.1,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { prompts, service }
}

/** The plugin's root (`plugins/mag`), derived from this module's own location, never `process.cwd()`. */
const repoRoot = join(import.meta.dirname, "..")

/** `node_modules` and `src` don't change mid-run, so every fixture shares one listing instead of re-reading the directory per call. */
const repoNodeModulesEntries = readdirSync(join(repoRoot, "node_modules"))
const repoSrcEntries = readdirSync(join(repoRoot, "src"))

/**
 * Builds a temp `graph-nodes/` tree from `specs`, one directory per node.
 *
 * Two-level layout: `<temp>/node_modules` sits beside `<temp>/graph-nodes`, never inside it — a
 * flat layout would put a phantom `node_modules` entry directly under the root passed to `--root`,
 * where the conformance sweep checks the node list. `<temp>/node_modules` is a real directory (not a
 * wholesale symlink of the repo's own `node_modules`) holding a symlink per real dependency plus a
 * `mag` shim package, so a fixture node's `mag/...` self-specifiers resolve the same way they do
 * in the real tree: `mag/runtime/*` and `mag/test/*` link back at the real plugin, and
 * `mag/graph-nodes/*` points at this fixture's own root, not the real tree's.
 */
export const nodeFixture = (specs: readonly NodeSpec[]): Fixture => {
  const temp = mkdtempSync(join(tmpdir(), "graph-conformance-"))
  const root = join(temp, "graph-nodes")
  mkdirSync(root, { recursive: true })

  const nodeModules = join(temp, "node_modules")
  mkdirSync(nodeModules, { recursive: true })
  for (const entry of repoNodeModulesEntries) {
    symlinkSync(join(repoRoot, "node_modules", entry), join(nodeModules, entry), "dir")
  }

  const shim = join(nodeModules, "mag")
  mkdirSync(shim, { recursive: true })
  symlinkSync(join(repoRoot, "package.json"), join(shim, "package.json"))

  const shimSrc = join(shim, "src")
  mkdirSync(shimSrc, { recursive: true })
  for (const entry of repoSrcEntries) {
    if (entry === "graph-nodes") continue
    symlinkSync(join(repoRoot, "src", entry), join(shimSrc, entry), "dir")
  }
  symlinkSync(root, join(shimSrc, "graph-nodes"), "dir")
  symlinkSync(join(repoRoot, "test"), join(shim, "test"), "dir")

  for (const spec of specs) {
    const nodeDir = join(root, spec.name)
    mkdirSync(nodeDir, { recursive: true })

    for (const dir of spec.directories ?? []) {
      mkdirSync(join(nodeDir, dir), { recursive: true })
    }

    for (const [filename, contents] of Object.entries(spec.files)) {
      const filePath = join(nodeDir, filename)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, contents)
    }
  }

  return {
    root,
    cleanup: () => rmSync(temp, { recursive: true, force: true })
  }
}

/** This fixture's single field: a primitive so `deriveFlagSpecs` can walk it (see below). */
const NestedFields = Schema.Struct({ label: Schema.String })
type NestedShape = Schema.Schema.Type<typeof NestedFields>

/**
 * An executable outer `GraphNode` whose `run` calls the boundary (`execute`, from
 * `mag/runtime/graph-node.definition`) on an INLINE inner `GraphNode` object — a plain object
 * literal defined right here, not a module under the `graph-nodes` directory and not an import of
 * one, since no node imports another node. Calling `execute` from inside a node's own `run` is
 * what makes the inner node run's span nest under the outer node run's span, so a subprocess test
 * can assert the inner open event's `parentSpanId` equals the outer open event's `spanId`.
 *
 * Both schemas stay to one primitive string field: `harness-cli-nested.ts` registers the RETURNED
 * outer node as a `{ kind: "command" }` registry entry, so `deriveFlagSpecs` walks its `input`
 * schema too, and a non-primitive field there fails the whole harness CLI build with
 * `UNSUPPORTED_INPUT_SCHEMA` (`schema-flags.ts:108-112`) — the inner node is never a registry
 * entry itself and carries no such constraint, but is kept primitive anyway for symmetry.
 */
export const nestedNodeFixture = (): GraphNode<NestedShape, NestedShape, never, never> => {
  const innerNode = make({
    name: "nested-inner",
    description: "Inline inner GraphNode; the outer's run calls execute() on it.",
    input: NestedFields,
    success: NestedFields,
    run: (input: NestedShape) => Effect.succeed(input)
  })

  return make({
    name: "nested-outer",
    description:
      "Outer GraphNode whose run calls execute() on an inline inner node, so a nested node run " +
      "records the outer node run's span as its parent.",
    input: NestedFields,
    success: NestedFields,
    run: (input: NestedShape) =>
      // `execute`'s inferred R is `unknown`, not `never`, purely because `GraphNode.input`/`.success`
      // are the erased `Schema.Schema<T>` view (`EncodingServices`/`DecodingServices` default to
      // `unknown` there) — the same erasure `src/runtime/trace/boundary.test.ts`'s `runTraced` and
      // `run-cli.ts`'s own `as Command.Command<...>` cast both name and cast past. Both this node's
      // and the inner's `NestedFields` schema are plain primitives with no service requirements, so
      // nothing is actually outstanding at runtime; this reasserts that structural truth.
      execute(innerNode, input) as Effect.Effect<NestedShape, never, never>
  })
}

/**
 * The `RunInfo` a node test provides when the node under test reads run-scoped constants
 * (`repoRoot` above all). Lives here rather than in the node's own test for the same shared-seam
 * reason as `removeDir` above: every node test needs the same fields pinned, and a copy per node
 * is the thing a shared seam forbids.
 */
export const testRunInfo = (overrides: Partial<RunInfoService> = {}): RunInfoService => {
  const repoRoot = overrides.repoRoot ?? "/repo"
  const workRoot = overrides.workRoot ?? repoRoot
  return {
    runId: "run-1",
    ticket: "GH-98",
    graph: "develop-graph",
    repoRoot,
    sha: "abc123",
    // Distinct from `sha` on purpose — the two name different checkouts, and a test that
    // conflated them would never catch a node reading the wrong one.
    pipelineSha: "def456",
    // A placeholder, never a writable directory — a record-writing node's own test overrides this
    // with a real disposable directory (`design/graph-node.test.ts`'s `withDirs`, `withForeignRepo`
    // below) once its dispatch reaches a real copy into the run root (`records.ts`'s `record`).
    runRoot: "/repo/.claude/graph/run-1",
    // Matches `repoRoot` by default, live-tree behaviour — a test that wants worktree mode
    // overrides this field explicitly, the same way any other field here is overridden.
    workRoot,
    // A home run by default — recordsRoot follows workRoot regardless of policy, so a test that
    // overrides workRoot without touching this keeps the placement a home run has.
    recordsRoot: workRoot,
    // The default a graph that says nothing gets — a test exercising `records: "committed"`
    // overrides it explicitly, the same way any other field here is.
    records: "run-root",
    ...overrides
  }
}

/**
 * A foreign-target run's two roots for a node test, under the default `records: "run-root"` policy —
 * the one case where they still differ (`run-layers.ts`): `workRoot` is the target checkout,
 * `recordsRoot` a separate disposable temp dir, stood in here by a second one, so a test can assert a
 * record's placement and the agent's dispatch cwd land on the two different roots they must. Under
 * `records: "committed"` a foreign run's `recordsRoot` equals `workRoot` instead — a test exercising
 * that policy overrides `recordsRoot` to `workRoot` on the returned `run`, rather than using this
 * fixture's own second dir. A third temp dir stands in for `runRoot`, `design/graph-node.test.ts`'s
 * `withDirs` reason: every record-writing node copies into it unconditionally
 * (`records.ts`'s `record`), so `run.runRoot` has to be a real, writable directory rather than
 * `testRunInfo`'s own placeholder default. Lives here rather than in each node's own test for
 * `removeDir`'s reason above: three nodes need the same fixture, and a copy per node is the thing a
 * shared seam forbids. `prefix` names the temp dirs after the node under test.
 */
export const withForeignRepo = async <T>(
  prefix: string,
  fn: (workRoot: string, recordsRoot: string, run: RunInfoService) => Promise<T>
): Promise<T> => {
  const workRoot = mkdtempSync(join(tmpdir(), `${prefix}-work-`))
  const recordsRoot = mkdtempSync(join(tmpdir(), `${prefix}-records-`))
  const runRoot = mkdtempSync(join(tmpdir(), `${prefix}-run-`))
  try {
    return await fn(workRoot, recordsRoot, testRunInfo({ repoRoot: workRoot, workRoot, recordsRoot, runRoot }))
  } finally {
    await removeDir(runRoot)
    await removeDir(workRoot)
    await removeDir(recordsRoot)
  }
}

/**
 * A real `journalLayer`, for a node whose own test proves composition (a run recording its
 * inner nodes' rows, a resume replaying without re-invoking them) rather than mocking the journal
 * away. Its config's own tag lives here, matched to `testRunInfo`'s default, for the same shared-seam
 * reason `testRunInfo` itself exists.
 */
export const testJournalLayer = (options: { readonly path: string; readonly predecessor: Option.Option<string> }) =>
  journalLayer({ ...options, graph: testRunInfo().graph })

/**
 * The stamp fields every row in one run's journal shares (`runId`/`ticket`/`graph`/
 * `repoRoot`/`sha`) — for a node test that writes synthetic rows straight to a `journal.jsonl` file
 * rather than through `journalLayer`, because it is reading OTHER runs' journals wholesale
 * (`gather-reviews` scans the whole graph root, not its own run). `graph` is fixed rather than an
 * override key: every row a caller writes with it shares one graph name.
 */
export const testJournalStamp = (
  overrides: Partial<{ runId: string; ticket: string; repoRoot: string; sha: string; pipelineSha: string }> = {}
) => ({
  runId: "run-1",
  ticket: "GH-98",
  graph: "develop-graph",
  repoRoot: "/repo",
  sha: "abc123",
  pipelineSha: "def456",
  ...overrides
})
