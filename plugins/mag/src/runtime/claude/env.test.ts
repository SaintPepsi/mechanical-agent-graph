import { describe, expect, test } from "bun:test"
import { composeEnv, ENV_MANIFEST, envShortfall } from "mag/runtime/claude/env"

/**
 * Pure, host record in, value out: every rule the transport enforces about what a spawned session
 * may see is asserted here without spawning anything. `agent.test.ts` proves the same rules against
 * a real child process.
 */

describe("composeEnv", () => {
  test("keeps every manifest name the host set", () => {
    const host = { PATH: "/usr/bin", HOME: "/home/x" }
    expect(composeEnv(host)).toEqual({ PATH: "/usr/bin", HOME: "/home/x" })
  })

  test("drops a name the host set that the manifest does not name", () => {
    const host = { PATH: "/usr/bin", TARGET_REPO_SECRET: "shh" }
    expect(composeEnv(host)).toEqual({ PATH: "/usr/bin" })
  })

  test("omits a manifest name the host never set", () => {
    expect(composeEnv({ PATH: "/usr/bin" })).not.toHaveProperty("HOME")
  })

  test("every manifest name is named exactly once", () => {
    expect(new Set(ENV_MANIFEST).size).toBe(ENV_MANIFEST.length)
  })

  describe("the KEEP_ANTHROPIC_ENV hatch", () => {
    test("off: an ANTHROPIC_* key stays absent", () => {
      const host = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" }
      expect(composeEnv(host)).toEqual({ PATH: "/usr/bin" })
    })

    /**
     * `TARGET_REPO_SECRET` staying absent alongside the re-admitted key is the pin for the narrow
     * reading: the hatch re-admits `ANTHROPIC_*` specifically, not the whole host environment.
     */
    test("on: ANTHROPIC_* is re-admitted, a foreign key still is not", () => {
      const host = { PATH: "/usr/bin", KEEP_ANTHROPIC_ENV: "1", ANTHROPIC_API_KEY: "sk-x", TARGET_REPO_SECRET: "shh" }
      expect(composeEnv(host)).toEqual({ PATH: "/usr/bin", KEEP_ANTHROPIC_ENV: "1", ANTHROPIC_API_KEY: "sk-x" })
    })

    test("any value other than the literal '1' leaves the hatch closed", () => {
      const host = { PATH: "/usr/bin", KEEP_ANTHROPIC_ENV: "true", ANTHROPIC_API_KEY: "sk-x" }
      expect(composeEnv(host)).toEqual({ PATH: "/usr/bin", KEEP_ANTHROPIC_ENV: "true" })
    })
  })
})

describe("envShortfall", () => {
  test("null when every declared name is satisfied", () => {
    const host = { PATH: "/usr/bin" }
    expect(envShortfall(["PATH"], composeEnv(host))).toBeNull()
  })

  test("null for no declared requirement", () => {
    expect(envShortfall([], {})).toBeNull()
  })

  test("withheld: the host holds it, the manifest does not name it", () => {
    const host = { TARGET_REPO_SECRET: "shh" }
    expect(envShortfall(["TARGET_REPO_SECRET"], composeEnv(host)))
      .toEqual({ name: "TARGET_REPO_SECRET", reason: "withheld" })
  })

  // Why membership and not host presence decides this: `envShortfall`'s own docblock.
  test("withheld even when the host never set it either: manifest membership decides, not host state", () => {
    expect(envShortfall(["TARGET_REPO_SECRET"], composeEnv({})))
      .toEqual({ name: "TARGET_REPO_SECRET", reason: "withheld" })
  })

  test("unset: the manifest names it, the host does not hold it", () => {
    expect(envShortfall(["HOME"], composeEnv({})))
      .toEqual({ name: "HOME", reason: "unset" })
  })

  test("the first shortfall in declaration order, when several names are missing", () => {
    const host = { TARGET_REPO_SECRET: "held-but-withheld" }
    expect(envShortfall(["HOME", "TARGET_REPO_SECRET"], composeEnv(host)))
      .toEqual({ name: "HOME", reason: "unset" })
  })
})
