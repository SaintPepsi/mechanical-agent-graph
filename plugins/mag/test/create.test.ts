import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { create } from "mag/graph-nodes/create/graph-node"
import { scaffold } from "mag/graph-nodes/create/scaffold"
import { conformance } from "mag/graph-nodes/conformance/graph-node"
import { renderSuccess } from "mag/runtime/render"
import { DEFAULT_GRAPH_NODES_ROOT } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { nodeFixture } from "mag/test/node-fixture"
import { runHarness } from "mag/test/run-harness"
import { nonEmptyLines, stripTraceLines } from "mag/test/stderr"

/**
 * Everything here lives outside `create/` because the node import-surface allowlist
 * (graph-node.shape.ts's ALLOW_RULES) forbids a node from importing `mag/test/run-harness`
 * and from importing the sibling `conformance` node. Only
 * `test/` files may do both, which is why the conformance run below and every subprocess test sit
 * here rather than in `create/graph-node.test.ts`.
 */

describe("create — a fresh scaffold conforms with no edits", () => {
  test("detect-remote, scaffolded then run through the real conformance node, checks it with zero violations", async () => {
    const fixture = nodeFixture([])
    try {
      await Effect.runPromise(
        scaffold(fixture.root, { name: "detect-remote", description: "Resolve the git remote" }).pipe(
          Effect.provide(platform)
        )
      )

      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))

      expect(result.checked).toEqual(["detect-remote"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a description full of quotes and backslashes still conforms", async () => {
    const fixture = nodeFixture([])
    try {
      await Effect.runPromise(
        scaffold(fixture.root, {
          name: "quote-check",
          description: 'Resolve the "git" remote \\ here — café ✅'
        }).pipe(Effect.provide(platform))
      )

      const result = await Effect.runPromise(conformance.run({ root: fixture.root }))

      expect(result.checked).toEqual(["quote-check"])
    } finally {
      fixture.cleanup()
    }
  })
})

/**
 * `renderSuccess`'s inferred `R` is `unknown`, not `never`, purely because `GraphNode.success` is
 * the erased `Schema.Schema<T>` view (`EncodingServices` defaults to `unknown` there) — the same
 * erasure `trace/boundary.test.ts`'s `runTraced` and `run-cli.ts`'s own `as Command.Command<...>`
 * both name and cast past. `create.success` is `Schema.Struct({ directory: Schema.String })`, a
 * plain primitive with no service requirements, so nothing is actually outstanding at runtime;
 * this reasserts that structural truth (a precise, concrete-type assertion, not `as any`/`as unknown as`).
 */
const runOwned = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("create — the success shape rendered", () => {
  test("renderSuccess writes exactly one JSON line carrying the created directory", async () => {
    const original = process.stdout.write.bind(process.stdout)
    let captured = ""
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }) as typeof process.stdout.write

    try {
      await runOwned(renderSuccess(create, { directory: "/tmp/graph-nodes/detect-remote" }))
    } finally {
      process.stdout.write = original
    }

    const lines = nonEmptyLines(captured)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toEqual({ directory: "/tmp/graph-nodes/detect-remote" })
  })
})

describe("create — bun test is red on a fresh scaffold", () => {
  test("bun test on the emitted graph-node.test.ts reports exactly one pass, one fail, and names detect-remote as unimplemented", async () => {
    const fixture = nodeFixture([])
    try {
      const name = "detect-remote"
      await Effect.runPromise(
        scaffold(fixture.root, { name, description: "Resolve the git remote" }).pipe(Effect.provide(platform))
      )
      const testFile = join(fixture.root, name, "graph-node.test.ts")

      const proc = Bun.spawn(["bun", "test", testFile], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ])
      // bun test's summary line lands on stderr, but this reads either stream so the assertion
      // never depends on which stream a future bun version chooses.
      const combined = `${stdout}\n${stderr}`

      expect(exitCode).not.toBe(0)

      // Assert on the pass/fail COUNTS, never bun's exact reporter text formatting.
      const passMatch = /(\d+)\s+pass\b/.exec(combined)
      const failMatch = /(\d+)\s+fail\b/.exec(combined)
      expect(passMatch).not.toBeNull()
      expect(failMatch).not.toBeNull()
      expect(Number(passMatch![1])).toBe(1)
      expect(Number(failMatch![1])).toBe(1)

      // Assert on the failing test's NAME, not on the surrounding punctuation/formatting.
      // The trailing `[<duration>]` is deliberately not part of the pattern: bun omits it for a
      // sub-millisecond test, which is exactly what the scaffold's one deliberate assertion is.
      const failLine = /^\(fail\) (.+)$/m.exec(combined)
      expect(failLine).not.toBeNull()
      expect(failLine![1]).toContain(name)
      expect(failLine![1].toLowerCase()).toContain("unimplemented")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("create — tsc is red on a fresh scaffold's run body only", () => {
  test("tsc --noEmit reports exactly one diagnostic, in graph-node.ts, naming detect-remote as unimplemented", async () => {
    const fixture = nodeFixture([])
    try {
      const name = "detect-remote"
      await Effect.runPromise(
        scaffold(fixture.root, { name, description: "Resolve the git remote" }).pipe(Effect.provide(platform))
      )
      const nodeDir = join(fixture.root, name)

      // Scoped to the two source files under test (never graph-node.test.ts, which needs bun:test's
      // ambient types this probe doesn't set up) -- same compiler options as plugins/mag/tsconfig.json,
      // minus "types": ["bun"], which this scope never references.
      writeFileSync(
        join(nodeDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            moduleResolution: "bundler",
            module: "ESNext",
            target: "ESNext",
            noEmit: true,
            skipLibCheck: true
          },
          include: ["graph-node.ts", "errors.ts"]
        })
      )

      const tscBin = join(import.meta.dir, "..", "..", "..", "node_modules", ".bin", "tsc")
      const proc = Bun.spawn([tscBin, "--noEmit", "-p", "."], { cwd: nodeDir, stdout: "pipe", stderr: "pipe" })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).not.toBe(0)

      // cwd is nodeDir, so tsc's diagnostic paths are relative -- "graph-node.ts(11,21): error TS2322: ...".
      const diagnostics = stdout.split("\n").filter((line) => /error TS\d+:/.test(line))
      expect(diagnostics.length).toBe(1)
      expect(diagnostics[0]).toStartWith("graph-node.ts")
      expect(diagnostics[0]).toContain(name)
      expect(diagnostics[0].toLowerCase()).toContain("unimplemented")
    } finally {
      fixture.cleanup()
    }
  }, 30_000)
})

describe("create — both flags required, subprocess through the real CLI", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("--name without --description fails before any root/write logic runs, nothing on stdout", async () => {
    // Argument parsing fails at parse time, before create.run (and therefore scaffold) ever
    // executes -- cli.test.ts's own "a missing required flag" test proves this structurally for
    // the same CLI framework. Safe against the live default root by construction.
    const { stdout, exitCode } = await run("node", "create", "--name", "detect-remote")

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
  })

  test("--description without --name fails before any root/write logic runs, nothing on stdout", async () => {
    const { stdout, exitCode } = await run("node", "create", "--description", "x")

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
  })
})

describe("create — an invalid name is rejected before anything is written", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("Detect_Remote exits 1 with one stderr line beginning CREATE_INVALID_NODE_NAME, nothing on stdout", async () => {
    // validName runs before makeDirectoryExclusive (scaffold.ts's ordering), so this is safe
    // against the live default root: rejection happens before any write logic runs.
    const { stdout, stderr, exitCode } = await run("node", "create", "--name", "Detect_Remote", "--description", "x")

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    const lines = nonEmptyLines(stripTraceLines(stderr))
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith("CREATE_INVALID_NODE_NAME")
  })
})

describe("create — no --force, the help surface", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("--help exits 0, lists --name and --description, and never --force", async () => {
    const { stdout, exitCode } = await run("node", "create", "--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("--name")
    expect(stdout).toContain("--description")
    expect(stdout).not.toContain("--force")
  })
})

describe("create — a collision against the LIVE default root is a hard stop", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("--name conformance fails CREATE_NODE_ALREADY_EXISTS and plugins/mag/src/graph-nodes/conformance/ is byte-for-byte untouched", async () => {
    // Safe against the live tree: makeDirectoryExclusive's single non-recursive fs.makeDirectory
    // call fails immediately because the directory already exists, so nothing is written before
    // this call even runs (scaffold.ts's own tests verify that ordering directly). Read the live
    // file's bytes BEFORE spawning, so the before/after comparison is a real proof, not an assumption.
    const conformanceSource = join(DEFAULT_GRAPH_NODES_ROOT, "conformance", "graph-node.ts")
    const bytesBefore = readFileSync(conformanceSource)

    const { stdout, stderr, exitCode } = await run("node", "create", "--name", "conformance", "--description", "x")

    const bytesAfter = readFileSync(conformanceSource)
    expect(bytesAfter).toEqual(bytesBefore)

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
    const lines = nonEmptyLines(stripTraceLines(stderr))
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith("CREATE_NODE_ALREADY_EXISTS")

    // Earns its keep: proves the default-root wiring end to end, not just "it failed".
    const match = /^CREATE_NODE_ALREADY_EXISTS: (\{.*\})$/.exec(lines[0])
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![1])
    expect(parsed.directory).toBe(join(DEFAULT_GRAPH_NODES_ROOT, "conformance"))
  })
})
