import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { DEFAULT_GRAPH_NODES_ROOT } from "mag/runtime/graph-node.shape"
import { platform, platformRefusal } from "mag/runtime/platform"

// The real assertion is that this file typechecks: yielding FileSystem.FileSystem and Path.Path
// then piping through `Effect.provide(platform)` only compiles if the requirement channel
// reduces to `never` — what keeps CommandNode's `R = never` true downstream.
describe("platform", () => {
  test("provides FileSystem and Path with no remaining requirement", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      return yield* fs.readDirectory(path.resolve(DEFAULT_GRAPH_NODES_ROOT))
    }).pipe(Effect.provide(platform))

    const entries = await Effect.runPromise(program)

    expect(Array.isArray(entries)).toBe(true)
  })
})

// win32 is refused; every other platform value (including WSL's own `linux`) passes untouched.
describe("platformRefusal", () => {
  test("refuses win32, naming WSL as the supported path", () => {
    const refusal = platformRefusal("win32")

    expect(refusal?.detail).toContain("win32")
    expect(refusal?.hint).toContain("WSL")
  })

  test.each(["linux", "darwin", "freebsd"])("passes %s with no refusal", (value) => {
    expect(platformRefusal(value)).toBeUndefined()
  })
})
