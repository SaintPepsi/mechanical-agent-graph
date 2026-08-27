export interface StockRow {
  readonly sku: string
  readonly available: number
}

export interface StockRepo {
  find(sku: string): Promise<StockRow | null>
  reserve(sku: string, quantity: number): Promise<void>
}

export type ReserveResult =
  | { readonly ok: true; readonly reserved: number; readonly remaining: number }
  | { readonly ok: false; readonly reason: "unknown-sku" }
  | { readonly ok: false; readonly reason: "insufficient"; readonly available: number }

export class InvalidQuantity extends Error {
  constructor(readonly quantity: number) {
    super(`quantity must be a positive integer, got ${quantity}`)
    this.name = "InvalidQuantity"
  }
}

/** Wraps whatever the repository threw so callers can tell a storage failure from a business answer. */
export class ReservationFailed extends Error {
  constructor(readonly sku: string, override readonly cause: unknown) {
    super(`could not reserve ${sku}`)
    this.name = "ReservationFailed"
  }
}

/**
 * Reserves stock for a sku.
 *
 * A caller asking for a nonsense quantity is a bug and throws. A sku that does not exist, or
 * that cannot cover the request, is an ordinary answer and comes back as a result — nothing is
 * written in either case. Only once the row is known to cover the request is `reserve` called.
 */
export async function reserveStock(
  repo: StockRepo,
  sku: string,
  quantity: number
): Promise<ReserveResult> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new InvalidQuantity(quantity)

  const row = await repo.find(sku)
  if (row === null) return { ok: false, reason: "unknown-sku" }
  if (row.available < quantity) return { ok: false, reason: "insufficient", available: row.available }

  try {
    await repo.reserve(sku, quantity)
  } catch (cause) {
    throw new ReservationFailed(sku, cause)
  }

  return { ok: true, reserved: quantity, remaining: row.available - quantity }
}
