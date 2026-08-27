import { Predicate } from "effect"

/**
 * Verdict parsing for schemaless calls: a raw `result` string in, an object or `null` out.
 *
 * A schema'd call reads `structured_output` and stops. This chain serves calls made without a
 * `--json-schema`, where the reply is prose that may contain the object somewhere inside it. Each
 * layer answers a failure that actually occurs: fenced JSON, prose wrapped around an object, and
 * objects nested inside unparseable outer spans.
 *
 * Pure: strings in, values out, no I/O.
 */

/** Strips one leading ```` ```json ```` / ```` ``` ```` fence and one trailing fence. */
export const stripFences = (s: string): string =>
  String(s).replace(/^\s*```(json)?\s*/, "").replace(/\s*```\s*$/, "")

/**
 * The index of the `}` closing the `{` at `start`, or `-1`. String-aware: braces inside quoted
 * strings are skipped, and a backslash escapes the next character inside a string.
 *
 * String tracking starts at `start`, not at the beginning of the text. That is the whole point —
 * see {@link extractJsonObject}.
 */
export const balancedEnd = (s: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The largest parseable top-level `{...}` span in `text`, or `null`.
 *
 * Largest wins so a reply whose outer object parses is preferred over a nested fragment of it. A
 * span that fails to parse (unquoted keys, say) leaves the scan running, because an inner object
 * may still parse.
 *
 * **Each candidate is scanned with fresh string state, and that is not an optimisation to remove.**
 * The text around the object is prose, not JSON, so its quotes carry no structure: one unpaired `"`
 * — an apostrophe-as-quote, an inch mark, an opening quote before a sentence — flips a
 * whole-text string parity and makes every following brace look like it sits inside a string. A
 * single scan that carried state across the prose returned `null` for
 * `The 5" panel is fine. Verdict: {"status": "pass"}`, which is exactly the shape this function
 * exists to read. Restarting at each `{` is what keeps quote parity a property of the candidate
 * rather than of everything that preceded it.
 *
 * The cost is a forward rescan per `{`, quadratic on brace-dense input. That is the price of
 * correctness here, and the input is one model reply.
 */
export const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const s = String(text)
  let best: { span: string; value: Record<string, unknown> } | null = null
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue
    const end = balancedEnd(s, i)
    if (end === -1) continue
    const span = s.slice(i, end + 1)
    try {
      const value: unknown = JSON.parse(span)
      if (Predicate.isObject(value) && (best === null || span.length > best.span.length)) {
        best = { span, value }
      }
      i = end
    } catch {
      // Unparseable span. Inner objects may still parse, so the scan continues from here.
    }
  }
  return best?.value ?? null
}

/**
 * The schemaless chain: strip fences and parse the whole string, else scan for the largest embedded
 * object. Returns `null` when `result` is absent or holds nothing parseable.
 */
export const parseResult = (result: string | null | undefined): Record<string, unknown> | null => {
  if (typeof result !== "string") return null
  try {
    const value: unknown = JSON.parse(stripFences(result))
    if (Predicate.isObject(value)) return value
  } catch {
    // Falls through to the embedded-object scan.
  }
  return extractJsonObject(result)
}
