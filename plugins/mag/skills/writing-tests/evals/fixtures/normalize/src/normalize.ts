export interface RawRow {
  readonly email?: string
  readonly name?: string
  readonly tags?: string
}

export interface Contact {
  readonly email: string
  readonly name: string
  readonly tags: readonly string[]
}

export interface NormalizeReport {
  readonly contacts: Contact[]
  readonly rejected: number
}

/** Turns raw imported rows into contacts. */
export function normalizeContacts(rows: readonly RawRow[]): NormalizeReport {
  const order: string[] = []
  const byEmail = new Map<string, { name: string; tags: string[] }>()
  let rejected = 0

  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase()
    if (email === "") {
      rejected += 1
      continue
    }

    const name = (row.name ?? "").trim()
    const tags = (row.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")

    const existing = byEmail.get(email)
    if (existing === undefined) {
      order.push(email)
      byEmail.set(email, { name, tags: dedupe(tags) })
      continue
    }

    existing.name = name
    existing.tags = dedupe([...existing.tags, ...tags])
  }

  return {
    contacts: order.map((email) => ({ email, ...byEmail.get(email)! })),
    rejected
  }
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}
