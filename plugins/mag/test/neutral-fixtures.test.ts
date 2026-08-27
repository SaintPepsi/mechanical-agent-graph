import { describe, expect, test } from "bun:test"
import { join } from "node:path"

/**
 * "No tracked test fixture or example carries a real home path" is a mechanical,
 * scripted check — house rule "mechanical before model" (root CLAUDE.md) — not a review instruction.
 * Direct precedent: `tracing-conformance.test.ts` scans real source text for `FORBIDDEN_TOKENS` for
 * exactly this reason. This file scans the tracked tree at HEAD (`git ls-files`, not a directory
 * walk) so untracked scratch and `node_modules` are structurally out of scope.
 */

interface ForbiddenPattern {
  readonly pattern: string
  readonly why: string
  /** `Ian` and `ian` are the same person; `/root/.claude` is a literal machine path, matched as written. */
  readonly caseInsensitive: boolean
}

interface Exemption {
  readonly prefix: string
  readonly why: string
}

interface Violation {
  readonly file: string
  readonly pattern: string
  readonly why: string
}

// The one home of "what counts as a real home path", as data. Forbidding another
// string is a row, never a branch.
const FORBIDDEN: ReadonlyArray<ForbiddenPattern> = [
  {
    pattern: "/Users/Ian",
    why: "macOS-style home path — also the substring that catches the /mnt/host/c/Users/Ian WSL mount",
    caseInsensitive: true
  },
  { pattern: "/home/ian", why: "POSIX home path", caseInsensitive: true },
  { pattern: "C:\\Users\\Ian", why: "Windows home path", caseInsensitive: true },
  { pattern: "/root/.claude", why: "a literal machine config-dir path", caseInsensitive: false }
]

// The scoped exemptions, as data, so they stop being tribal knowledge: one home, each row carrying
// the reason it's exempt. Empty today: nothing tracked is allowed to quote a real home path.
const EXEMPT: ReadonlyArray<Exemption> = []

// The guard's own source necessarily contains every forbidden pattern as data, so it excludes
// itself by path rather than by widening EXEMPT, which is reserved for these narrow, deliberate cases.
const GUARD_SOURCE = "plugins/mag/test/neutral-fixtures.test.ts"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const isExempt = (file: string): boolean => file === GUARD_SOURCE || EXEMPT.some((row) => file.startsWith(row.prefix))

const matches = (row: ForbiddenPattern, text: string): boolean =>
  row.caseInsensitive ? text.toLowerCase().includes(row.pattern.toLowerCase()) : text.includes(row.pattern)

const scan = (file: string, text: string): ReadonlyArray<Violation> =>
  FORBIDDEN.filter((row) => matches(row, text)).map((row) => ({ file, pattern: row.pattern, why: row.why }))

/** The tracked tree at HEAD. A `git ls-files` failure fails loudly — a guard scanning nothing reports green forever. */
const trackedFiles = async (): Promise<ReadonlyArray<string>> => {
  const proc = Bun.spawn(["git", "ls-files"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ls-files failed with exit code ${exitCode}: ${await new Response(proc.stderr).text()}`)
  return stdout.split("\n").filter((line) => line !== "")
}

/** Binary skipped at the read boundary (a NUL byte), not by widening FORBIDDEN with an extension list. */
const isBinary = (bytes: Uint8Array): boolean => bytes.includes(0)

const readText = async (path: string): Promise<string | null> => {
  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
    return isBinary(bytes) ? null : new TextDecoder().decode(bytes)
  } catch {
    return null // unreadable (gone, a symlink with no target) is skipped, not a crash
  }
}

describe("neutral fixtures", () => {
  test("no tracked file carries a real home path", async () => {
    const files = (await trackedFiles()).filter((file) => !isExempt(file))
    const violations: Array<Violation> = []
    for (const file of files) {
      const text = await readText(join(REPO_ROOT, file))
      if (text !== null) violations.push(...scan(file, text))
    }

    if (violations.length > 0) {
      throw new Error(
        `Real home path(s) in tracked files:\n${
          violations.map((v) => `${v.file}: matched ${JSON.stringify(v.pattern)} — ${v.why}`).join("\n")
        }`
      )
    }
    expect(violations).toEqual([])
  })

  test("EXEMPT is still exactly this exhaustive list — a new row here should be as visible as a new violation", () => {
    expect(EXEMPT.map((row) => row.prefix)).toEqual([])
  })
})
