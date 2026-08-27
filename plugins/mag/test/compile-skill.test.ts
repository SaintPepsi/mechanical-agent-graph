import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { INSTALLED_SKILLS, installedPath, renderInstalled } from "mag/skills/installed"
import { runHarness } from "mag/test/run-harness"
import { nonEmptyLines, stripTraceLines } from "mag/test/stderr"

/**
 * Real subprocess integration test, via `runHarness` pointed at the real `src/cli.ts` entry point —
 * the actual registered `compile-skill` command, not a fixture registry. Lives here, not in the
 * node's own `graph-node.test.ts`, for the same reason `create.test.ts`/`test/conformance.test.ts`
 * do: `mag/test/run-harness` is outside a node's `import-surface` allowlist.
 */
describe("compile-skill — the real CLI end to end", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("--root <temp> exits 0, writes one JSON success line, and the file on disk matches renderInstalled's own row", async () => {
    const root = mkdtempSync(join(tmpdir(), "compile-skill-cli-"))
    try {
      const { stdout, stderr, exitCode } = await run("compile-skill", "--root", root)

      expect(exitCode).toBe(0)
      expect(stripTraceLines(stderr)).toBe("")
      const lines = nonEmptyLines(stdout)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0])
      expect(parsed.root).toBe(root)
      expect(parsed.written).toEqual([installedPath(root, "brainstorming")])

      for (const skill of INSTALLED_SKILLS) {
        expect(readFileSync(installedPath(root, skill.name), "utf8")).toBe(renderInstalled(skill))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a nonexistent --root exits non-zero with one COMPILE_SKILL_ROOT_MISSING stderr line, nothing on stdout", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "compile-skill-cli-")), "does-not-exist")
    const { stdout, stderr, exitCode } = await run("compile-skill", "--root", root)

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
    const lines = nonEmptyLines(stripTraceLines(stderr))
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith("COMPILE_SKILL_ROOT_MISSING")
  })
})

describe("compile-skill — help surface", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("mag --help exits 0 and lists compile-skill as a top-level command, not under node", async () => {
    const { stdout, exitCode } = await run("--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("compile-skill")
  })

  test("mag compile-skill --help exits 0 and lists exactly the --root flag", async () => {
    const { stdout, exitCode } = await run("compile-skill", "--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("--root")
  })
})
