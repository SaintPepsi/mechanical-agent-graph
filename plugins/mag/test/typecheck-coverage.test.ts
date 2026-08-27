import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

/**
 * A build-config claim, not a runtime one: "a deliberate type error anywhere in
 * plugins/mag fails bun run typecheck at the repo root". The mechanical proxy for that is file
 * coverage — if every `.ts` file under `plugins/mag` is in the program the plugin's own
 * typecheck script builds, a type error anywhere in one of those files surfaces. This spawns the
 * real root delegation (`bun run --cwd plugins/mag typecheck`, with `--listFiles` forwarded to
 * tsc), never a re-declared config.
 */

const pluginDir = join(import.meta.dir, "..")
const repoRoot = join(import.meta.dir, "..", "..", "..")

const listSourceFiles = async (): Promise<readonly string[]> => {
  const files: string[] = []
  for await (const file of new Glob("{src,test}/**/*.ts").scan({ cwd: pluginDir, onlyFiles: true })) {
    files.push(file)
  }
  return files.sort()
}

describe("root typecheck delegation covers every file in plugins/mag", () => {
  test("the delegated typecheck with --listFiles includes every src/**/*.ts and test/**/*.ts file", async () => {
    const expected = await listSourceFiles()
    expect(expected.length).toBeGreaterThan(0)

    // The root script's own delegation, verbatim, with --listFiles forwarded through to tsc.
    const proc = Bun.spawn(["bun", "run", "--cwd", "plugins/mag", "typecheck", "--listFiles"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe"
    })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

    expect(exitCode).toBe(0)
    for (const file of expected) {
      expect(stdout).toContain(join(pluginDir, file))
    }
    // This spawns a whole tsc compile, so it is bounded by compile time, never by anything this
    // test asserts — it checks file coverage, not latency. Effect v4's type surface puts the
    // compile around 3.5s locally, close enough to bun's 5s default that a slower CI runner tips
    // it over. The budget is generous on purpose: a real hang still fails, a slow machine does not.
  }, 60_000)

  test("the root typecheck script delegates to plugins/mag's own script and repeats no compiler option", async () => {
    const rootPackageJson = await Bun.file(join(repoRoot, "package.json")).json()
    const rootScript: string = rootPackageJson.scripts.typecheck

    // The root delegates the plugin's own typecheck to the plugin's script, so the compiler flags
    // for plugins/mag live in one tsconfig.json and nothing here duplicates them.
    expect(rootScript).toContain("bun run --cwd plugins/mag typecheck")
    expect(rootScript).not.toContain("tsc")

    const pluginPackageJson = await Bun.file(join(pluginDir, "package.json")).json()
    expect(pluginPackageJson.scripts.typecheck).toBe("tsc --noEmit -p .")
  })
})
