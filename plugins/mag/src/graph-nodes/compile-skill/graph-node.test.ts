import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { SkillsRootMissing, SkillWriteFailed } from "mag/graph-nodes/compile-skill/errors"
import { compileSkill } from "mag/graph-nodes/compile-skill/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/compile-skill/examples"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { INSTALLED_SKILLS, installedPath, renderInstalled } from "mag/skills/installed"

describe("compile-skill", () => {
  test("the fixtures decode against compile-skill's own schemas", () => {
    if (!isSchemaHandle(compileSkill.input)) throw new Error("compileSkill.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(compileSkill.input)(example)
    if (!isSchemaHandle(compileSkill.success)) throw new Error("compileSkill.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(compileSkill.success)(example)
  })

  test("writes the installed variant byte-identical to renderInstalled's own row, one entry per row", async () => {
    const root = mkdtempSync(join(tmpdir(), "compile-skill-"))
    try {
      const result = await Effect.runPromise(Effect.result(compileSkill.run({ root })))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      // One written entry per INSTALLED_SKILLS row — a row that never gets written is a red test.
      expect(result.success).toStrictEqual({ root, written: INSTALLED_SKILLS.map((skill) => installedPath(root, skill.name)) })
      for (const skill of INSTALLED_SKILLS) {
        expect(readFileSync(installedPath(root, skill.name), "utf8")).toBe(renderInstalled(skill))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a nonexistent root fails SkillsRootMissing before any write", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "compile-skill-")), "does-not-exist")
    const result = await Effect.runPromise(Effect.result(compileSkill.run({ root })))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SkillsRootMissing)
    expect((result.failure as SkillsRootMissing).root).toBe(root)
  })

  test("a root whose own existence check raises (ENAMETOOLONG) still fails SkillsRootMissing, not a raw PlatformError", async () => {
    // `fs.exists` doesn't just answer false for an unusable root, it can itself throw. An overlong
    // `--root` is the reachable way to make it throw, and the node's error union stays the two
    // domain tags in errors.ts, never PlatformError.
    const root = "/tmp/" + "a".repeat(5000)
    const result = await Effect.runPromise(Effect.result(compileSkill.run({ root })))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SkillsRootMissing)
    expect((result.failure as SkillsRootMissing).root).toBe(root)
  })

  test("a root that is a file, not a directory, fails SkillWriteFailed", async () => {
    const base = mkdtempSync(join(tmpdir(), "compile-skill-"))
    const root = join(base, "not-a-directory")
    writeFileSync(root, "not a directory")
    try {
      const result = await Effect.runPromise(Effect.result(compileSkill.run({ root })))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(SkillWriteFailed)
      expect((result.failure as SkillWriteFailed).path).toBe(installedPath(root, "brainstorming"))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
