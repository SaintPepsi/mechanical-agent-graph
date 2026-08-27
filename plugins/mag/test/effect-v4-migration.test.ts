import { describe, expect, test } from "bun:test"
import { join } from "node:path"

/**
 * Install-state/doc-content claims, not runtime behaviour: does the
 * plugin actually depend on Effect v4, and does CLAUDE.md actually carry the guidance stanza. Both
 * are mechanically checkable, so they get committed regression coverage instead of staying
 * hand-verified facts that could silently regress on a future edit.
 */

const pluginDir = join(import.meta.dir, "..")
const repoRoot = join(import.meta.dir, "..", "..", "..")

describe("plugins/mag depends on Effect v4", () => {
  test("plugins/mag/package.json names effect@beta", async () => {
    const pkg = await Bun.file(join(pluginDir, "package.json")).json()
    expect(pkg.dependencies.effect).toBe("beta")
  })

  test("node_modules/effect resolves to a 4.x build and ships AGENTS.md", async () => {
    const effectPkg = await Bun.file(join(repoRoot, "node_modules/effect/package.json")).json()
    expect(effectPkg.version.startsWith("4.")).toBe(true)
    expect(await Bun.file(join(repoRoot, "node_modules/effect/AGENTS.md")).exists()).toBe(true)
  })
})

describe("CLAUDE.md carries the Effect guidance stanza", () => {
  test("instructs reading AGENTS.md fully and searching node_modules/effect/src for uncovered APIs", async () => {
    const claudeMd = await Bun.file(join(repoRoot, "CLAUDE.md")).text()
    expect(claudeMd).toContain("node_modules/effect/AGENTS.md")
    expect(claudeMd).toContain("node_modules/effect/src")
  })
})
