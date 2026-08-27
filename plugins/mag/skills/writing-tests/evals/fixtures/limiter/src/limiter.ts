export type Clock = () => number

export interface Decision {
  readonly allowed: boolean
  readonly remaining: number
  readonly retryAfterMs: number
}

/** A sliding-window rate limiter. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = () => Date.now()
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer")
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be a positive integer")
  }

  private live(key: string, now: number): number[] {
    const all = this.hits.get(key) ?? []
    const cutoff = now - this.windowMs
    const kept = all.filter((t) => t > cutoff)
    this.hits.set(key, kept)
    return kept
  }

  /** Records a hit for `key` if there is room. */
  check(key: string): Decision {
    const now = this.clock()
    const kept = this.live(key, now)

    if (kept.length >= this.limit) {
      const oldest = kept[0]!
      return { allowed: false, remaining: 0, retryAfterMs: oldest + this.windowMs - now }
    }

    kept.push(now)
    return { allowed: true, remaining: this.limit - kept.length, retryAfterMs: 0 }
  }

  /** Reports what `check` would decide, without recording anything. */
  peek(key: string): Decision {
    const now = this.clock()
    const all = this.hits.get(key) ?? []
    const kept = all.filter((t) => t > now - this.windowMs)

    if (kept.length >= this.limit) {
      const oldest = kept[0]!
      return { allowed: false, remaining: 0, retryAfterMs: oldest + this.windowMs - now }
    }
    return { allowed: true, remaining: this.limit - kept.length, retryAfterMs: 0 }
  }

  /** Forgets one key, or everything. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear()
    else this.hits.delete(key)
  }
}
