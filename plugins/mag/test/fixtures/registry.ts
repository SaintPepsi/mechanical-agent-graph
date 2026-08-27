import type { Registry } from "mag/runtime/types"
import { badInput } from "./bad-input"
import { boom } from "./boom"
import { echo } from "./echo"
import { explode } from "./explode"
import { halt } from "./halt"
import { secret } from "./secret"
import { throwsFixture } from "./throws"

/**
 * Three testable levels for "--help works at every level": the root (this tree itself),
 * a group ("utility", two children), and a leaf command at the top level ("explode").
 *
 * `secret` and `halt` are registered at the TOP LEVEL, beside `explode`/`throwsFixture`
 * — NOT inside the `utility` group — so `cli.test.ts`'s group-help `.toContain` assertions (which
 * enumerate `utility`'s exact children) stay accurate.
 */
export const fixtureRegistry: Registry = [
  {
    kind: "group",
    group: "utility",
    description: "Utility fixture commands for exercising the CLI's happy and error paths.",
    children: [
      { kind: "command", node: echo },
      { kind: "command", node: boom },
    ],
  },
  { kind: "command", node: explode },
  { kind: "command", node: throwsFixture },
  { kind: "command", node: secret },
  { kind: "command", node: halt },
]

/** Just the unsupported-schema node, alone, so the whole CLI fails to build. */
export const unsupportedRegistry: Registry = [{ kind: "command", node: badInput }]
