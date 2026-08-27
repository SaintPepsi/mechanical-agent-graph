import { Effect, FileSystem, Path, Schema } from "effect"
import { SkillsRootMissing, SkillWriteFailed } from "mag/graph-nodes/compile-skill/errors"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { INSTALLED_SKILLS, type InstalledSkill, installedPath, renderInstalled, SKILLS_ROOT } from "mag/skills/installed"

/**
 * Renders one row and puts it on disk — the node's only I/O. `FileSystem`/`Path` ride the R
 * channel, yielded here rather than threaded through parameters: a helper that needs a service
 * pulls it from its own context, `root`/`skill` stay data. `destination` is composed once and
 * reused in the catch, so a mid-write platform failure still names the path it was writing to.
 */
const materialize = (root: string, skill: InstalledSkill) => {
  const destination = installedPath(root, skill.name)
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
    yield* fs.writeFileString(destination, renderInstalled(skill))
    return destination
  }).pipe(Effect.catch((error) => Effect.fail(new SkillWriteFailed({ path: destination, detail: String(error) }))))
}

export const compileSkill = make({
  name: "compile-skill",
  description: "Compile every installed skill to its SKILL.md.",
  input: Schema.Struct({ root: Schema.optional(Schema.String) }),
  success: Schema.Struct({ root: Schema.String, written: Schema.Array(Schema.String) }),
  run: (input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      // Same convention as conformance/graph-node.ts: a relative --root resolves against the
      // process working directory here, at the input boundary — left relative, a path means one
      // thing to a filesystem read and another to a resolver.
      const root = input.root === undefined ? SKILLS_ROOT : path.resolve(input.root)
      // `exists` itself can raise (e.g. ENAMETOOLONG on a pathological `--root`), not just answer
      // false — swallowed here so the node's error union stays the two domain tags in errors.ts,
      // not `PlatformError | SkillsRootMissing | SkillWriteFailed`.
      // Unusable and nonexistent both mean the same thing to this node: it can't render into root.
      const rootExists = yield* fs.exists(root).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!rootExists) return yield* Effect.fail(new SkillsRootMissing({ root }))
      const written = yield* Effect.forEach(INSTALLED_SKILLS, (skill) => materialize(root, skill))
      return { root, written }
    }).pipe(Effect.provide(platform))
})
