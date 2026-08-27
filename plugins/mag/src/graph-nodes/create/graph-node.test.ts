import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Result } from "effect"
import { InvalidDescription, InvalidNodeName, NodeAlreadyExists, ScaffoldFailed } from "mag/graph-nodes/create/errors"
import { scaffold, withCleanup } from "mag/graph-nodes/create/scaffold"
import { emittedFiles, RESERVED_BINDINGS, toCamel } from "mag/graph-nodes/create/template"
import { cleanDescription, validName } from "mag/graph-nodes/create/validation"
import { escapeQuoted } from "mag/runtime/escape"
import {
  carriesUnimplementedMarker,
  EXAMPLE_EXPORTS,
  importSpecifiers,
  isAllowedImport,
  REQUIRED_FILES
} from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { nodeFixture } from "mag/test/node-fixture"

describe("scaffold", () => {
  test("emits exactly the required files, and nothing else in the root", async () => {
    const fixture = nodeFixture([])
    try {
      const { directory } = await Effect.runPromise(
        scaffold(fixture.root, { name: "detect-remote", description: "Resolve the git remote" }).pipe(
          Effect.provide(platform)
        )
      )

      expect(directory).toBe(join(fixture.root, "detect-remote"))
      expect(readdirSync(directory).sort()).toEqual([...REQUIRED_FILES].sort())
      expect(readdirSync(fixture.root)).toEqual(["detect-remote"])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("RESERVED_BINDINGS", () => {
  // A template import or loop-var missing from RESERVED_BINDINGS is a real scaffold bug, and hand-
  // maintaining that mirror invites the next one. Instead, scan the templates' own emitted output
  // for every binding they introduce and assert each one is covered, so a missed identifier shows
  // up as a red test here rather than shipping.
  test("every fixed binding the emitted files introduce is covered by RESERVED_BINDINGS", () => {
    const name = "probe-node"
    const camel = toCamel(name)
    const files = emittedFiles(name, "probe description")

    const boundIdentifiers = new Set<string>()
    for (const source of Object.values(files)) {
      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
        for (const specifier of match[1].split(",")) boundIdentifiers.add(specifier.trim())
      }
      for (const match of source.matchAll(/for\s*\(const\s+(\w+)\s+of/g)) {
        boundIdentifiers.add(match[1])
      }
    }
    // The node's own export is name-derived, not fixed -- it's the thing RESERVED_BINDINGS protects
    // against colliding with, not a binding that itself needs reserving.
    boundIdentifiers.delete(camel)

    for (const identifier of boundIdentifiers) {
      // toCamel never produces an uppercase-leading identifier (names are anchored to
      // ^[a-z][a-z0-9]*(-[a-z0-9]+)*$), so a capitalized import (Schema, Data, ...) can't collide.
      if (identifier[0] !== identifier[0].toLowerCase()) continue
      expect(RESERVED_BINDINGS.has(identifier)).toBe(true)
    }
  })
})

describe("validName", () => {
  const accepted = ["a", "detect-remote", "a1", "x-2-y"]

  test.each(accepted)("%s is accepted, returned verbatim", (name) => {
    const result = validName(name)
    expect(Result.isSuccess(result)).toBe(true)
    expect(Result.getOrThrow(result)).toBe(name)
  })

  const rejected = [
    "",
    "Detect-Remote",
    "detect_remote",
    "1detect",
    "-detect",
    "detect-",
    "detect--remote",
    "detect remote",
    "detect.remote",
    "../escape",
    "detect-remote\n"
  ]

  test.each(rejected)("%j is rejected with CREATE_INVALID_NODE_NAME", (name) => {
    const result = validName(name)
    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))
    expect(error).toBeInstanceOf(InvalidNodeName)
    expect(error._tag).toBe("CREATE_INVALID_NODE_NAME")
  })

  test("the pattern carried on the error is the one anchored regex's source, not a second copy", () => {
    const result = validName("Bad Name")
    const error = Result.getOrThrow(Result.flip(result))
    expect(error.pattern).toBe("^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
  })

  // Names the pattern above accepts (they match [a-z][a-z0-9]*(-[a-z0-9]+)*) but whose camelCase
  // identifier is either an ECMAScript reserved word or collides with a binding the emitted
  // templates hard-import or hard-bind -- both would otherwise parse-fail the scaffold on arrival,
  // or (for "example", the for-of loop variable testSource emits) silently shadow the imported
  // node inside the loop body.
  const reservedOrColliding = ["delete", "new", "import", "make", "test", "describe", "expect", "example"]

  test.each(reservedOrColliding)(
    "%j matches the pattern but is rejected as a reserved/colliding identifier",
    (name) => {
      const result = validName(name)
      expect(Result.isFailure(result)).toBe(true)
      const error = Result.getOrThrow(Result.flip(result))
      expect(error).toBeInstanceOf(InvalidNodeName)
      expect(error._tag).toBe("CREATE_INVALID_NODE_NAME")
      expect(error.reason).toContain(name)
    }
  )
})

describe("cleanDescription", () => {
  const accepted = [
    "Resolve the git remote",
    'Resolve the "git" remote \\ here',
    "Résolvé the gît rémote — café",
    "Resolve the git remote for this repository please"
  ]

  test.each(accepted)("%j is accepted, returned verbatim", (description) => {
    const result = cleanDescription(description)
    expect(Result.isSuccess(result)).toBe(true)
    expect(Result.getOrThrow(result)).toBe(description)
  })

  test("an accepted description with leading/trailing spaces is returned byte-identical, never trimmed", () => {
    const description = " leading and trailing "
    const result = cleanDescription(description)
    expect(Result.isSuccess(result)).toBe(true)
    expect(Result.getOrThrow(result)).toBe(description)
  })

  const rejected: ReadonlyArray<[string, string]> = [
    ["", ""],
    ["whitespace-only", "   "],
    ["contains \\n", "Resolve the\ngit remote"],
    ["contains \\r", "Resolve the\rgit remote"],
    ["contains \\t", "Resolve the\tgit remote"],
    ["contains \\u0000", "Resolve the\u0000git remote"]
  ]

  test.each(rejected)("description that %s is rejected with CREATE_INVALID_DESCRIPTION", (_label, description) => {
    const result = cleanDescription(description)
    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))
    expect(error).toBeInstanceOf(InvalidDescription)
    expect(error._tag).toBe("CREATE_INVALID_DESCRIPTION")
  })

  test("empty and whitespace-only share one reason, distinct from the multi-line and control-character reasons", () => {
    const empty = Result.getOrThrow(Result.flip(cleanDescription("")))
    const whitespaceOnly = Result.getOrThrow(Result.flip(cleanDescription("   ")))
    const multiline = Result.getOrThrow(Result.flip(cleanDescription("Resolve the\ngit remote")))
    const carriageReturn = Result.getOrThrow(Result.flip(cleanDescription("Resolve the\rgit remote")))
    const controlCharacter = Result.getOrThrow(Result.flip(cleanDescription("Resolve the\tgit remote")))

    expect(empty.reason).toBe(whitespaceOnly.reason)
    expect(multiline.reason).toBe(carriageReturn.reason)
    expect(multiline.reason).not.toBe(empty.reason)
    expect(multiline.reason).not.toBe(controlCharacter.reason)
    expect(controlCharacter.reason).not.toBe(empty.reason)
  })
})

describe("scaffold — nothing is written on a validation failure", () => {
  test("an invalid name fails with CREATE_INVALID_NODE_NAME and leaves the root empty", async () => {
    const fixture = nodeFixture([])
    try {
      const failure = await Effect.runPromise(
        scaffold(fixture.root, { name: "Not Valid", description: "Resolve the git remote" }).pipe(
          Effect.provide(platform),
          Effect.flip
        )
      )

      expect(failure).toBeInstanceOf(InvalidNodeName)
      expect(failure._tag).toBe("CREATE_INVALID_NODE_NAME")
      expect(readdirSync(fixture.root)).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("a pattern-legal but colliding name (\"make\") fails with CREATE_INVALID_NODE_NAME and leaves the root empty, instead of scaffolding a broken node", async () => {
    const fixture = nodeFixture([])
    try {
      const failure = await Effect.runPromise(
        scaffold(fixture.root, { name: "make", description: "Resolve the git remote" }).pipe(
          Effect.provide(platform),
          Effect.flip
        )
      )

      expect(failure).toBeInstanceOf(InvalidNodeName)
      expect(failure._tag).toBe("CREATE_INVALID_NODE_NAME")
      expect(readdirSync(fixture.root)).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("an invalid description fails with CREATE_INVALID_DESCRIPTION and leaves the root empty", async () => {
    const fixture = nodeFixture([])
    try {
      const failure = await Effect.runPromise(
        scaffold(fixture.root, { name: "detect-remote", description: "   " }).pipe(
          Effect.provide(platform),
          Effect.flip
        )
      )

      expect(failure).toBeInstanceOf(InvalidDescription)
      expect(failure._tag).toBe("CREATE_INVALID_DESCRIPTION")
      expect(readdirSync(fixture.root)).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("scaffold — collision", () => {
  test("a pre-existing directory is a hard stop, and is never touched", async () => {
    const fixture = nodeFixture([{ name: "detect-remote", files: { "marker.txt": "do not touch" } }])
    try {
      const existingDirectory = join(fixture.root, "detect-remote")
      const entriesBefore = readdirSync(existingDirectory).sort()
      const bytesBefore = readFileSync(join(existingDirectory, "marker.txt"))

      const failure = await Effect.runPromise(
        scaffold(fixture.root, { name: "detect-remote", description: "Resolve the git remote" }).pipe(
          Effect.provide(platform),
          Effect.flip
        )
      )

      expect(failure).toBeInstanceOf(NodeAlreadyExists)
      expect(failure._tag).toBe("CREATE_NODE_ALREADY_EXISTS")
      expect(readdirSync(existingDirectory).sort()).toEqual(entriesBefore)
      expect(readFileSync(join(existingDirectory, "marker.txt"))).toEqual(bytesBefore)
      expect(readdirSync(fixture.root)).toEqual(["detect-remote"])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("withCleanup", () => {
  test("a succeeding effect leaves the directory in place", async () => {
    const fixture = nodeFixture([])
    try {
      const directory = join(fixture.root, "kept")
      mkdirSync(directory)

      const result = await Effect.runPromise(
        withCleanup(directory, Effect.succeed("ok")).pipe(Effect.provide(platform))
      )

      expect(result).toBe("ok")
      expect(existsSync(directory)).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test("a failing effect removes the directory", async () => {
    const fixture = nodeFixture([])
    try {
      const directory = join(fixture.root, "removed-on-failure")
      mkdirSync(directory)
      const original = new ScaffoldFailed({ directory, detail: "boom" })

      const failure = await Effect.runPromise(
        withCleanup(directory, Effect.fail(original)).pipe(Effect.provide(platform), Effect.flip)
      )

      expect(failure).toBe(original)
      expect(existsSync(directory)).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("an interrupted effect removes the directory", async () => {
    const fixture = nodeFixture([])
    try {
      const directory = join(fixture.root, "removed-on-interrupt")
      mkdirSync(directory)

      // Fork and interrupt in one program: `Fiber.interrupt` awaits the fiber's own completion,
      // including `withCleanup`'s `onExit` finalizer, so the directory is gone once this resolves.
      // `startImmediately: true` is required -- an un-started fiber interrupted before its first
      // tick never runs any of its ops, `onExit`'s registration included, and the finalizer is
      // silently skipped.
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDetach(withCleanup(directory, Effect.never).pipe(Effect.provide(platform)), {
            startImmediately: true
          })
          yield* Fiber.interrupt(fiber)
        })
      )

      expect(existsSync(directory)).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test("when the removal itself also fails, the original error still surfaces unchanged", async () => {
    // Points cleanup at a path that was never created, so the removal itself fails (`NotFound`) --
    // proof that `Effect.ignore` on the removal keeps the original error intact rather than
    // replacing it with the cleanup's own failure.
    const original = new ScaffoldFailed({ directory: "irrelevant", detail: "boom" })
    const neverCreatedDirectory = "/nonexistent-gh-87-ac07/never-created"

    const failure = await Effect.runPromise(
      withCleanup(neverCreatedDirectory, Effect.fail(original)).pipe(Effect.provide(platform), Effect.flip)
    )

    expect(failure).toBe(original)
  })
})

describe("scaffold — cleanup on write failure, end-to-end", () => {
  test("a write failure part-way through cleans up, so a retry is not blocked", async () => {
    const fixture = nodeFixture([])
    try {
      // A non-recursive `makeDirectory` is exclusive, so nothing can be pre-seeded inside
      // the node directory before `scaffold` creates it -- that same exclusivity
      // also forecloses the obvious "pre-create one target filename as a directory" trick. Instead,
      // the write phase is made to fail structurally: `root` is built deep enough that creating the
      // (short) node directory itself stays under the filesystem's PATH_MAX, but joining any of the
      // four required filenames onto it does not, so every `writeFileString` fails ENAMETOOLONG
      // after the directory already exists -- a genuine write-phase failure, not a collision.
      // Usable path length (PATH_MAX minus the NUL) is 1023 on Darwin and 4095 on Linux, measured
      // against the resolved path: the root is realpath'd so a symlinked tmpdir (macOS's
      // /var -> /private/var) does not eat into the budget. Thresholds scale with it, and the last
      // stride is sized to land on target rather than overshoot from a long macOS temp root.
      const USABLE = process.platform === "darwin" ? 1023 : 4095
      let deepRoot = realpathSync(fixture.root)
      const target = USABLE - 65
      while (deepRoot.length < target) {
        deepRoot = join(deepRoot, "a".repeat(Math.min(200, target - deepRoot.length)))
        mkdirSync(deepRoot, { recursive: true })
      }
      // Node directory lands 5 under the limit; the shortest emitted filename (14 chars) tips it over.
      const name = "b".repeat(Math.max(1, USABLE - 5 - deepRoot.length - 1))

      const failure = await Effect.runPromise(
        scaffold(deepRoot, { name, description: "Resolve the git remote" }).pipe(Effect.provide(platform), Effect.flip)
      )

      expect(failure).toBeInstanceOf(ScaffoldFailed)
      expect(failure._tag).toBe("CREATE_SCAFFOLD_FAILED")
      expect(readdirSync(deepRoot)).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})

describe("emittedFiles", () => {
  const NAME = "detect-remote"
  const DESCRIPTION = "Resolve the \"git\" remote \\ here"
  const files = emittedFiles(NAME, DESCRIPTION)

  test("graph-node.ts carries the name, the escaped description, both empty schemas, and imports make", () => {
    const source = files["graph-node.ts"]
    expect(source).toContain(`"${NAME}"`)
    expect(source).toContain(escapeQuoted(DESCRIPTION))
    expect(source.match(/Schema\.Struct\(\{\}\)/g)?.length).toBe(2)
    expect(source).toContain('from "mag/runtime/graph-node.definition"')
    expect(source).toContain("make(")
  })

  test("errors.ts declares one tagged error class, tag SCREAMING_SNAKE_FAILED, string fields only", () => {
    const source = files["errors.ts"]
    expect(source).toContain('Data.TaggedError("DETECT_REMOTE_FAILED")')
    const fields = [...source.matchAll(/readonly (\w+): (\w+)/g)]
    expect(fields.length).toBeGreaterThan(0)
    for (const [, , fieldType] of fields) expect(fieldType).toBe("string")
  })

  test("examples.ts exports one non-empty array per EXAMPLE_EXPORTS name", () => {
    const source = files["examples.ts"]
    for (const exportName of EXAMPLE_EXPORTS) {
      const match = source.match(new RegExp(`export const ${exportName} = (\\[[^\\n]*\\])`))
      expect(match).not.toBeNull()
      const array = JSON.parse(match![1])
      expect(Array.isArray(array)).toBe(true)
      expect(array.length).toBeGreaterThan(0)
    }
  })

  test("graph-node.test.ts imports the node and fixtures through the absolute self-prefix, never relatively", () => {
    const source = files["graph-node.test.ts"]
    const specifiers = importSpecifiers(source)
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) expect(specifier.startsWith(".")).toBe(false)
    const selfSpecifiers = specifiers.filter((specifier) => specifier.startsWith(`mag/graph-nodes/${NAME}/`))
    expect(selfSpecifiers.length).toBeGreaterThan(0)
  })

  test("graph-node.ts carries a never-annotated run whose literal opens with UNIMPLEMENTED_MARKER", () => {
    const source = files["graph-node.ts"]
    expect(source).toContain(": never")
    expect(carriesUnimplementedMarker(source)).toBe(true)
  })

  test("the marker literal names the node and says it is unimplemented", () => {
    const source = files["graph-node.ts"]
    expect(source).toContain(NAME)
    expect(source).toContain("unimplemented")
  })

  test("every emitted file survives Bun's TypeScript parser for a description with quotes, backslashes and non-ASCII", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const unicodeFiles = emittedFiles(NAME, "Resolve the \"git\" remote \\ here — café ✅")
    for (const source of Object.values(unicodeFiles)) {
      expect(() => transpiler.transformSync(source)).not.toThrow()
    }
  })

  test("every imported specifier in each emitted file is allowed for this node", () => {
    for (const source of Object.values(files)) {
      for (const specifier of importSpecifiers(source)) {
        expect(isAllowedImport(specifier, NAME)).toBe(true)
      }
    }
  })
})
