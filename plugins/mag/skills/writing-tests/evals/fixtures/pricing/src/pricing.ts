export interface CartLine {
  readonly sku: string
  readonly unitPriceCents: number
  readonly quantity: number
}

export class InvalidLine extends Error {
  constructor(readonly sku: string, message: string) {
    super(`${sku}: ${message}`)
    this.name = "InvalidLine"
  }
}

/** Sum of every line. Rejects a line that could only come from a bug upstream. */
export function subtotalCents(lines: readonly CartLine[]): number {
  let total = 0
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new InvalidLine(line.sku, "quantity must be a non-negative integer")
    }
    if (!Number.isInteger(line.unitPriceCents)) {
      throw new InvalidLine(line.sku, "unitPriceCents must be an integer")
    }
    total += line.unitPriceCents * line.quantity
  }
  return total
}

/**
 * Members get 10% from 10000 cents up; everyone else gets 5% from that same threshold.
 * Below the threshold nobody gets anything.
 */
export function discountRateFor(subtotal: number, isMember: boolean): number {
  if (subtotal >= 10000) return isMember ? 0.1 : 0.05
  return 0
}

/** Applies a rate and lands back on a whole number of cents, rounding half away from zero. */
export function applyDiscount(subtotal: number, rate: number): number {
  if (rate < 0 || rate > 1) throw new RangeError(`rate out of range: ${rate}`)
  return subtotal - Math.round(subtotal * rate)
}

/** `$1,234.56`; negatives carry the sign outside the symbol: `-$1.00`. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new TypeError(`not a whole number of cents: ${cents}`)
  const negative = cents < 0
  const abs = Math.abs(cents)
  const whole = String(Math.floor(abs / 100))
  const fraction = String(abs % 100).padStart(2, "0")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}$${grouped}.${fraction}`
}
