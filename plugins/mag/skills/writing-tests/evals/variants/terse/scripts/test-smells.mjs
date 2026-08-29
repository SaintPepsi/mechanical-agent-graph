#!/usr/bin/env node
/**
 * test-smells — a mechanical reader for JS/TS test files.
 *
 * It finds the flaws that are decidable by looking at the text: a test with no
 * assertion, an assertion stranded inside an un-awaited promise, a test whose
 * matchers can never fail. It cannot tell you whether a test is testing the
 * right thing — that is what watching it fail is for.
 *
 * Usage:
 *   node test-smells.mjs <file|dir> [...]   # exits 1 if any error-level smell
 *   node test-smells.mjs --json <paths>     # machine-readable
 *   node test-smells.mjs --strict <paths>   # warnings fail too
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, extname, basename } from "node:path"

const WEAK_MATCHERS = new Set([
  "toBeDefined", "toBeTruthy", "toBeFalsy", "toBeNaN"
])
const INTERACTION_MATCHERS = new Set([
  "toHaveBeenCalled", "toHaveBeenCalledWith", "toHaveBeenCalledTimes",
  "toHaveBeenNthCalledWith", "toHaveBeenCalledOnce", "toHaveBeenLastCalledWith",
  "toBeCalled", "toBeCalledWith", "toBeCalledTimes"
])
// `throw` counts: a test that throws on the condition it cares about is asserting, just not via `expect`.
// A helper named expect*/assert* is an assertion too — projects wrap their own.
const ASSERTION_HINTS = /\bexpect\w*\s*\(|\bassert\w*\s*\(|\bassert\b|\bthrow\b|\.toThrow/

/** True when a `/` at `i` starts a regex literal rather than a division. */
function regexPosition(src, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j]
    if (c === " " || c === "\t" || c === "\n") continue
    return "(,=:[!&|?{;+-*%~^<>".includes(c) || /[\s]/.test(c)
  }
  return true
}

/** Replace the *contents* of strings, templates, regexes and comments with spaces, keeping offsets and identifiers intact. */
function blank(src) {
  const out = src.split("")
  let i = 0
  let state = "code"
  const wipe = (n) => { if (out[n] !== "\n") out[n] = " " }
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; i += 2; continue }
      if (c === "/" && d === "*") { state = "block"; i += 2; continue }
      if (c === "/" && d !== "/" && d !== "*" && regexPosition(src, i)) {
        // A regex literal's ( ) [ ] { } are not structure. Blank its body so they cannot
        // unbalance the paren matching that finds test bodies.
        let j = i + 1, inClass = false
        for (; j < src.length; j++) {
          const ch = src[j]
          if (ch === "\\") { j++; continue }
          if (ch === "\n") break
          if (inClass) { if (ch === "]") inClass = false; continue }
          if (ch === "[") { inClass = true; continue }
          if (ch === "/") break
        }
        for (let k = i + 1; k < Math.min(j, src.length); k++) wipe(k)
        i = j + 1; continue
      }
      if (c === "'") { state = "single"; i++; continue }
      if (c === '"') { state = "double"; i++; continue }
      if (c === "`") { state = "tmpl"; i++; continue }
      i++; continue
    }
    if (state === "line") { if (c === "\n") state = "code"; else wipe(i); i++; continue }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; i += 2; continue }
      wipe(i); i++; continue
    }
    if (state === "single" || state === "double") {
      const q = state === "single" ? "'" : '"'
      if (c === "\\") { wipe(i); wipe(i + 1); i += 2; continue }
      if (c === q) { state = "code"; i++; continue }
      wipe(i); i++; continue
    }
    if (state === "tmpl") {
      if (c === "\\") { wipe(i); wipe(i + 1); i += 2; continue }
      if (c === "$" && d === "{") {
        // Blank the whole interpolation, braces included: a `${x}` in a test name would
        // otherwise look like the start of the callback body and derail every offset below.
        let depth = 0, j = i + 1
        for (; j < src.length; j++) {
          if (src[j] === "{") depth++
          else if (src[j] === "}") { depth--; if (depth === 0) break }
        }
        for (let k = i; k <= Math.min(j, src.length - 1); k++) wipe(k)
        i = j + 1; continue
      }
      if (c === "`") { state = "code"; i++; continue }
      wipe(i); i++; continue
    }
  }
  return out.join("")
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length

/** Brace-match forward from `from`; returns the index just past the closing brace, or -1. */
function matchBrace(blanked, from) {
  const open = blanked.indexOf("{", from)
  if (open === -1) return [-1, -1]
  let depth = 0
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === "{") depth++
    else if (blanked[i] === "}") { depth--; if (depth === 0) return [open + 1, i] }
  }
  return [-1, -1]
}

/** Paren-match forward from the `(` at or after `from`; returns [start, end) of the contents. */
function matchParen(blanked, from) {
  const open = blanked.indexOf("(", from)
  if (open === -1) return [-1, -1]
  let depth = 0
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === "(") depth++
    else if (blanked[i] === ")") { depth--; if (depth === 0) return [open + 1, i] }
  }
  return [-1, -1]
}

/** Every `test(...)` / `it(...)` block in the file, with its body text. */
function testBlocks(src, blanked) {
  const blocks = []
  const re = /(^|[^.\w$])(test|it)\s*(\.\s*(each|failing|concurrent|serial|only|skip|todo))?\s*\(/gm
  let m
  while ((m = re.exec(blanked)) !== null) {
    // Paren-match the whole `test(...)` call rather than brace-matching a body: the callback may
    // have a concise expression body, and a destructuring parameter's `{` would otherwise be
    // mistaken for the start of the body.
    // Match from the end of the regex (which lands on the call's own `(`), not from m.index —
    // `test.each(cases)(name, fn)` would otherwise hand back `each`'s argument as the body.
    let [start, end] = matchParen(blanked, m.index + m[0].length - 1)
    if (start === -1) continue
    if (m[4] === "each") {
      // `.each(cases)(name, fn)` — the group just matched is `cases`; the test body is the next call.
      ;[start, end] = matchParen(blanked, end + 1)
      if (start === -1) continue
    }
    const head = src.slice(m.index, Math.min(start + 200, end))
    const nameMatch = head.match(/["'`](.*?)["'`]/s)
    blocks.push({
      name: nameMatch ? nameMatch[1].replace(/\s+/g, " ").slice(0, 80) : "(unnamed)",
      line: lineOf(src, m.index),
      head,
      body: src.slice(start, end),
      blanked: blanked.slice(start, end),
      offset: start
    })
    re.lastIndex = end
  }
  return blocks
}

const matchersIn = (text) => {
  const names = new Set()
  for (const m of text.matchAll(/\.\s*(to[A-Z][A-Za-z]*)\s*\(/g)) names.add(m[1])
  return names
}

/**
 * The statement containing `idx`. `stops` decides how far back to scan: a promise chain is
 * routinely written across several lines, so its `return`/`await` sits before a newline, while
 * the self-referential check needs the tighter line-scoped view to avoid swallowing its
 * neighbours in semicolon-free code.
 */
/**
 * Text preceding `idx` at nesting depth 0 — balanced (...), [...] and {...} groups are skipped
 * whole. `return foo({ a: 1 }).then(...)` therefore still shows its `return`, which a naive
 * back-scan loses at the object literal's brace.
 */
function outerPrefix(text, idx) {
  const out = []
  let i = idx - 1
  const openerOf = { ")": "(", "]": "[", "}": "{" }
  while (i >= 0) {
    const c = text[i]
    if (c in openerOf) {
      const open = openerOf[c]
      let depth = 0
      for (; i >= 0; i--) {
        if (text[i] === c) depth++
        else if (text[i] === open) { depth--; if (depth === 0) break }
      }
      i--
      continue
    }
    if (c === ";" || c === "{") break
    out.push(c)
    i--
  }
  return out.reverse().join("")
}

function statementAround(text, idx, stops = ";{}\n") {
  let s = idx
  while (s > 0 && !stops.includes(text[s - 1])) s--
  let e = idx
  while (e < text.length && !";\n".includes(text[e])) e++
  return text.slice(s, e)
}

function inspect(path) {
  const src = readFileSync(path, "utf8")
  const blanked = blank(src)
  const findings = []
  const add = (severity, rule, line, message) => findings.push({ path, severity, rule, line, message })

  for (const m of blanked.matchAll(/\b(test|it|describe)\s*\.\s*only\s*\(/g)) {
    add("error", "focused-test", lineOf(src, m.index),
      `\`.only\` left in the file — the rest of the suite silently does not run in this file.`)
  }
  for (const m of blanked.matchAll(/\b(test|it|describe)\s*\.\s*(skip|todo)\s*\(/g)) {
    add("warn", "skipped-test", lineOf(src, m.index),
      `\`.${m[2]}\` — a skipped test is a green tick that checks nothing. Fix it or delete it.`)
  }

  const blocks = testBlocks(src, blanked)
  if (blocks.length === 0) {
    return { path, findings, tests: 0 }
  }

  for (const b of blocks) {
    const at = (offsetInBody) => lineOf(src, b.offset + offsetInBody)
    const isAsync = /\basync\b/.test(b.head)

    if (!ASSERTION_HINTS.test(b.blanked)) {
      add("error", "no-assertion", b.line,
        `"${b.name}" runs code but asserts nothing — it passes for every possible behaviour of the code it calls.`)
      continue
    }

    for (const m of b.blanked.matchAll(/\.\s*(then|catch|finally)\s*\(/g)) {
      const [s, e] = matchParen(b.blanked, m.index)
      const cbHasExpect = s !== -1 && /\bexpect\s*\(/.test(b.blanked.slice(s, e))
      const stmt = outerPrefix(b.blanked, m.index)
      if (cbHasExpect && !/\b(await|return)\b/.test(stmt)) {
        add("error", "assertion-in-floating-then", at(m.index),
          `"${b.name}" asserts inside a \`.then()\` that is never awaited or returned — the test ends before the assertion runs, so it passes whatever the result is.`)
      }
    }

    for (const m of b.blanked.matchAll(/\bexpect\s*\([^)]*\)[\s\S]{0,40}?\.\s*(resolves|rejects)\b/g)) {
      const stmt = outerPrefix(b.blanked, m.index)
      if (!/\b(await|return)\b/.test(stmt)) {
        add("error", "floating-async-matcher", at(m.index),
          `"${b.name}" uses \`.${m[1]}\` without \`await\`/\`return\` — the assertion is a dangling promise and cannot fail the test.`)
      }
    }

    for (const m of b.blanked.matchAll(/\b(forEach|map)\s*\(\s*async\b/g)) {
      add("error", "async-callback-in-loop", at(m.index),
        `"${b.name}" passes an \`async\` callback to \`${m[1]}\` — the promises are dropped, so assertions inside it never fail the test. Use \`for (const x of …)\` with \`await\`.`)
    }

    const matchers = matchersIn(b.blanked)
    if (matchers.size > 0 && [...matchers].every((n) => WEAK_MATCHERS.has(n))) {
      add("warn", "weak-assertion-only", b.line,
        `"${b.name}" only asserts ${[...matchers].join("/")} — that passes for \`{}\`, \`"x"\`, and most wrong answers. Assert the value you expect.`)
    }
    if (/\bnot\s*\.\s*toThrow\s*\(/.test(b.blanked) && matchers.size === 0) {
      add("warn", "weak-assertion-only", b.line,
        `"${b.name}" only asserts that nothing threw — that is true of almost every wrong implementation too.`)
    }
    if (matchers.size > 0 && [...matchers].every((n) => INTERACTION_MATCHERS.has(n))) {
      add("warn", "interaction-only", b.line,
        `"${b.name}" only asserts which collaborators were called. That breaks on refactors and stays green on wrong results — assert the value or state the caller observes.`)
    }

    for (const m of b.blanked.matchAll(/\bexpect\s*\.\s*(any|anything)\s*\(/g)) {
      add("warn", "unfalsifiable-matcher", at(m.index),
        `"${b.name}" matches with \`expect.${m[1]}\` — it accepts every value of that type. Pin the value that proves the behaviour.`)
    }
    for (const m of b.blanked.matchAll(/\.\s*length\s*\)\s*\.\s*toBeGreaterThanOrEqual\s*\(\s*0\s*\)/g)) {
      add("warn", "unfalsifiable-matcher", at(m.index),
        `"${b.name}" asserts a length is >= 0, which is true of every array.`)
    }
    for (const m of b.blanked.matchAll(/\.\s*toMatchSnapshot\s*\(/g)) {
      add("warn", "snapshot", at(m.index),
        `"${b.name}" uses a snapshot — snapshots only catch bugs if a human reads the diff, and they get \`-u\`'d away. Prefer an explicit expected value for behaviour you care about.`)
    }

    // Expected value re-derived from the code under test rather than written down.
    for (const m of b.blanked.matchAll(/\bexpect\s*\(\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = m[1]
      const stmt = statementAround(b.blanked, m.index)
      const afterMatcher = stmt.slice(stmt.indexOf(".to"))
      if (afterMatcher && new RegExp(`\\b${fn}\\s*\\(`).test(afterMatcher)) {
        add("warn", "self-referential-expectation", at(m.index),
          `"${b.name}" calls \`${fn}()\` on both sides of the assertion — if \`${fn}\` is wrong, the expectation is wrong in exactly the same way. Write the expected value out as a literal.`)
      }
    }

    if (isAsync && !/\bawait\b/.test(b.blanked)) {
      add("warn", "async-without-await", b.line,
        `"${b.name}" is declared \`async\` but never awaits — if the code under test is asynchronous, the assertions are racing it.`)
    }
  }

  for (const m of blanked.matchAll(/\b(Math\s*\.\s*random|Date\s*\.\s*now)\s*\(/g)) {
    add("warn", "nondeterminism", lineOf(src, m.index),
      `\`${m[1].replace(/\s+/g, "")}()\` in a test — the result changes between runs, so a pass today is not a pass tomorrow. Inject the value or freeze the clock.`)
  }
  for (const m of blanked.matchAll(/\bnew\s+Date\s*\(\s*\)/g)) {
    add("warn", "nondeterminism", lineOf(src, m.index),
      `\`new Date()\` with no argument — the test depends on when it runs. Pass a fixed instant.`)
  }
  for (const m of blanked.matchAll(/\.\s*toLocale(Date|Time)?String\s*\(/g)) {
    add("warn", "nondeterminism", lineOf(src, m.index),
      `\`toLocale…String\` — the output depends on the machine's locale and timezone, so this passes for you and fails in CI.`)
  }

  const tests = blocks.map((b) => {
    const matchers = [...matchersIn(b.blanked)]
    const real = matchers.filter((m) => !WEAK_MATCHERS.has(m))
    return {
      name: b.name,
      line: b.line,
      matchers,
      asserts: ASSERTION_HINTS.test(b.blanked),
      /** "dead" = nothing here could fail for a wrong-but-plausible implementation. */
      dead: !ASSERTION_HINTS.test(b.blanked) || (matchers.length > 0 && real.length === 0)
    }
  })
  return { path, findings, tests: blocks.length, testRecords: tests }
}

const IS_TEST_FILE = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p)

/** Walking a directory picks up test files only; a file named explicitly is always inspected. */
function collect(target, acc = [], explicit = true) {
  const s = statSync(target)
  if (s.isDirectory()) {
    if (["node_modules", ".git", "dist", "build", "coverage"].includes(basename(target))) return acc
    for (const entry of readdirSync(target)) collect(join(target, entry), acc, false)
    return acc
  }
  const known = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(extname(target))
  if (known && (explicit || IS_TEST_FILE(target))) acc.push(target)
  return acc
}

const args = process.argv.slice(2)
const json = args.includes("--json")
const strict = args.includes("--strict")
const targets = args.filter((a) => !a.startsWith("--"))

if (targets.length === 0) {
  console.error("usage: test-smells.mjs [--json] [--strict] <file|dir> ...")
  process.exit(2)
}

const files = targets.flatMap((t) => collect(t))
const results = files.map(inspect)
const findings = results.flatMap((r) => r.findings)
const errors = findings.filter((f) => f.severity === "error")
const warns = findings.filter((f) => f.severity === "warn")

if (json) {
  console.log(JSON.stringify({
    files: files.length,
    tests: results.reduce((n, r) => n + r.tests, 0),
    errors: errors.length,
    warnings: warns.length,
    findings,
    testRecords: results.flatMap((r) => (r.testRecords ?? []).map((t) => ({ ...t, path: r.path })))
  }, null, 2))
} else {
  for (const f of findings) {
    const tag = f.severity === "error" ? "ERROR" : "warn "
    console.log(`${tag} ${f.path}:${f.line}  [${f.rule}]\n      ${f.message}`)
  }
  const tests = results.reduce((n, r) => n + r.tests, 0)
  console.log(`\n${files.length} file(s), ${tests} test(s): ${errors.length} error(s), ${warns.length} warning(s).`)
  if (findings.length === 0) console.log("No mechanical smells. This says nothing about whether the tests would catch a bug — see the skill's red-first step.")
}

process.exit(errors.length > 0 || (strict && warns.length > 0) ? 1 : 0)
