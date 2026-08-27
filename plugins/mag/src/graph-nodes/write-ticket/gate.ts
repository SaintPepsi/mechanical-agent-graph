/**
 * The pure predicates `write-ticket` runs before and after dispatch: a pure function is not a
 * capability, so these ride inside the node rather than beside it as a GraphNode of their own.
 */

/** A sentence-terminator followed by more content names a second sentence: the input is a paragraph, not one sentence. */
const SECOND_SENTENCE = /[.!?]\s+\S/

/** Empty fails the same as two sentences — both leave nothing a single Gherkin field can hold. */
export const isOneSentence = (value: string): boolean => {
  const trimmed = value.trim()
  return trimmed !== "" && !SECOND_SENTENCE.test(trimmed)
}

/** `criteriaPath`'s own format: one criterion per line, blank lines dropped. */
export const parseCriteriaLines = (raw: string): readonly string[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

/**
 * The coverage clause, mechanical: every provided sentence must be carried by one criterion's
 * `source`, trimmed, matched one-to-one rather than by membership, so two identical provided
 * sentences need two distinct echoes. A criterion the writer added beyond the provided list carries
 * no `source` and is never consulted: a floor, not a ceiling.
 */
export const droppedCriteria = (
  provided: readonly string[],
  sources: readonly (string | undefined)[]
): readonly string[] => {
  const remaining = sources.filter((source): source is string => source !== undefined).map((source) => source.trim())
  const dropped: string[] = []
  for (const criterion of provided) {
    const trimmed = criterion.trim()
    const index = remaining.indexOf(trimmed)
    if (index === -1) dropped.push(criterion)
    else remaining.splice(index, 1)
  }
  return dropped
}
