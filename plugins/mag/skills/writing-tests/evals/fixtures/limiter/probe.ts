import { SlidingWindow } from "./src/limiter"
const out: unknown[] = []
for (const [limit, win] of [[1, 100], [2, 100], [3, 1000]] as const) {
  let t = 500
  const l = new SlidingWindow(limit, win, () => t)
  for (const step of [0, 0, 0, 50, 50, 1, 1000, 0]) {
    t += step
    out.push(["check-a", l.check("a"), "peek-a", l.peek("a"), "check-b", l.check("b")])
  }
  l.reset("a"); out.push(["after-reset-a", l.check("a"), l.check("b")])
  l.reset(); out.push(["after-reset-all", l.check("a"), l.check("b")])
}
for (const bad of [[0, 100], [-1, 100], [1.5, 100], [1, 0], [1, -1]] as const) {
  try { new SlidingWindow(bad[0], bad[1]); out.push(["no-throw", bad]) }
  catch (e) { out.push(["throw", bad, (e as Error).message]) }
}
console.log(JSON.stringify(out))
