const CLAIM = {
  path: "src/limiter.ts",
  find: "this.hits.delete(key)",
  replace: "this.hits.clear()",
  probeSource: "bun -e 'const { Limiter } = await import(\"./src/limiter.ts\"); const l = new Limiter(); l.check(\"a\"); l.check(\"b\"); l.reset(\"a\"); console.log(l.count(\"b\"))'",
  rationale: "reset(key) wipes every key's state, a cross-tenant quota reset"
}

export const inputExamples = [
  { claims: [CLAIM], command: "bun run typecheck && bun run test" },
  { claims: [], command: "bun run typecheck && bun run test" }
]

export const successExamples = [
  { escapes: [], tried: 1 },
  { escapes: [{ path: CLAIM.path, find: CLAIM.find, replace: CLAIM.replace, probeSource: CLAIM.probeSource }], tried: 1 }
]
