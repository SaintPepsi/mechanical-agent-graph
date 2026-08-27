/**
 * Shared stderr line-filtering helpers for `plugins/mag/test`.
 *
 * GraphNode lifecycle tracing makes every node run write `mag: `-prefixed lines to
 * stderr. This is the ONE place every stderr assertion in this suite routes through to strip those
 * lines back out before asserting on "real" stderr content — instead of each test file carrying its
 * own local copy of the filtering logic.
 */

/**
 * Removes every line beginning `mag: `, leaving every other line — and the string's trailing
 * newline shape — untouched.
 */
export const stripTraceLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("mag: "))
    .join("\n")

/**
 * `stripTraceLines`'s exact complement: every line beginning `mag: `, in order, and nothing else.
 * This is the ONE function every later tracing test should read `mag:` lines through —
 * it exists now so no later task writes a second copy of this split.
 */
export const traceLines = (text: string): readonly string[] => text.split("\n").filter((line) => line.startsWith("mag: "))

/** Non-empty lines only — the one split `cli.test.ts` and `conformance.test.ts` both read through. */
export const nonEmptyLines = (text: string): readonly string[] => text.split("\n").filter((line) => line.length > 0)
