import type { Concern } from "mag/skills/design/concern"

/** Fires for every audience: a refactor ticket is exactly where "no design needed" is tempting,
 * whether or not a user is in the room. The tail is "not optional" rather than "get approval":
 * `hard-gate` (interactive) and `autonomy` (headless) each own approval's shape for their own
 * audience, and a second, contradictory instruction about it here would be dead weight. */
export const noTooSimple: Concern<"any"> = {
  id: "no-too-simple",
  audience: "any",
  section: {
    heading: `## Anti-Pattern: "This Is Too Simple To Need A Design"`,
    body: () =>
      `Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but it is not optional.\n\n`
  }
}
