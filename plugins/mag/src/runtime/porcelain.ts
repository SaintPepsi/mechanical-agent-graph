/**
 * `git status --porcelain` (v1, no `-z`): a fixed two-character status code, a space, then the
 * path. Parsed in exactly one place, beside the other small pure runtime modules (`escape.ts`,
 * `render.ts`), because `build`
 * needs the same read to answer a coarser question ("is there anything at all"), and the porcelain
 * line format deserves one home rather than two ("Single Source of Truth", used in 2+ files).
 */
export const dirtyPaths = (stdout: string): readonly string[] =>
  stdout.split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3))
