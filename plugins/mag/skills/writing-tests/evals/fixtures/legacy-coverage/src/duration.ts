const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

export class InvalidDuration extends Error {
  constructor(readonly input: string, reason: string) {
    super(`invalid duration ${JSON.stringify(input)}: ${reason}`)
    this.name = "InvalidDuration"
  }
}

/**
 * Parses a human duration into milliseconds.
 *
 * `"1h30m"`, `"1h 30m"` and `"90m"` are all 5_400_000. Units are ms/s/m/h/d, case-insensitive.
 * Repeated units add up. Anything else — an empty string, a bare number, an unknown unit, a
 * negative or fractional amount, trailing junk — is rejected rather than guessed at.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim()
  if (trimmed === "") throw new InvalidDuration(input, "empty")

  const segment = /(\d+)\s*(ms|s|m|h|d)/giy
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null

  while ((match = segment.exec(trimmed)) !== null) {
    const amount = Number(match[1])
    const unit = match[2]!.toLowerCase()
    total += amount * UNIT_MS[unit]!
    consumed = segment.lastIndex
    while (consumed < trimmed.length && trimmed[consumed] === " ") {
      consumed += 1
      segment.lastIndex = consumed
    }
  }

  if (consumed !== trimmed.length) throw new InvalidDuration(input, "unparsed trailing input")
  return total
}

/** Renders a whole number of milliseconds back into the shortest exact form. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new InvalidDuration(String(ms), "not a non-negative integer")
  if (ms === 0) return "0ms"

  const parts: string[] = []
  let rest = ms
  for (const unit of ["d", "h", "m", "s", "ms"]) {
    const size = UNIT_MS[unit]!
    const count = Math.floor(rest / size)
    if (count > 0) {
      parts.push(`${count}${unit}`)
      rest -= count * size
    }
  }
  return parts.join("")
}
