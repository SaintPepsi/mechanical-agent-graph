import { Option } from "effect"

/**
 * Deciding whether a recorded row describes *this* invocation.
 *
 * A journal row replays only when the input it recorded is the input the node is being handed now.
 * Object key order is not part of that question — `{ ticket, title }` and `{ title, ticket }` are
 * the same input — so both sides normalise to a key-sorted rendering before they are compared as
 * strings.
 */

/** Walks a parsed-JSON value — plain objects, arrays and primitives only — sorting object keys. */
const canonicalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalise(record[key])]))
  }
  return value
}

/**
 * A key-sorted rendering of `value`, or `None` when it has none — `undefined`, a `bigint`, a cycle,
 * a `toJSON` that throws. `None` is what makes an unrenderable input run fresh: {@link sameInput}
 * treats it as a mismatch on either side, so such a node re-runs on every invocation rather than
 * replaying against a comparison that could not be made.
 *
 * The value is rendered by `JSON.stringify` FIRST and canonicalised as parsed JSON, so identity
 * here is identity of the JSON rendering — the very form the journal writes to disk. Canonicalising
 * the raw value instead would compare by a different rule than the file records (`toJSON` honoured
 * on one side only, `NaN` distinct from the `null` it lands as), and both directions of that
 * divergence were observed as bugs: a `Date` input that never replayed, and a mismatched input that
 * did. One consequence to know: a value whose rendering loses information (a `Map` renders as `{}`)
 * matches by what the record can actually see.
 */
export const canonicalJson = (value: unknown): Option.Option<string> => {
  try {
    const rendered = JSON.stringify(value)
    if (rendered === undefined) return Option.none()
    return Option.some(JSON.stringify(canonicalise(JSON.parse(rendered) as unknown)))
  } catch {
    return Option.none()
  }
}

/**
 * Asks {@link sameInput}'s question of many recorded inputs against one current input, with the
 * current side rendered once up front. Scanning a journal poses the same question of every
 * candidate row, so the current input is canonicalised before the scan rather than inside it.
 *
 * A current input with no canonical form can match nothing, so it answers `false` without looking
 * at a row at all.
 */
export const matchesInput = (current: Option.Option<unknown>): (recorded: Option.Option<unknown>) => boolean => {
  const right = Option.flatMap(current, canonicalJson)
  if (Option.isNone(right)) return () => false
  return (recorded) => {
    const left = Option.flatMap(recorded, canonicalJson)
    return Option.isSome(left) && left.value === right.value
  }
}

/**
 * Do a recorded input and the current one describe the same invocation? Only when both are present
 * and both render to the same canonical string. A missing input on either side is a mismatch: a row
 * carries no `input` field exactly when the input could not be encoded, and an input nobody can
 * write down is an input nobody can match.
 */
export const sameInput = (recorded: Option.Option<unknown>, current: Option.Option<unknown>): boolean =>
  matchesInput(current)(recorded)
