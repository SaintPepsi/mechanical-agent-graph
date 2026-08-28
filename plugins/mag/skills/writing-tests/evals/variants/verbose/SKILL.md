---
name: writing-tests
description: "Make unit tests able to fail: choose inputs that tell correct code apart from plausibly-wrong code, assert whole values as literals, cover the contract's negative space (what the code promises *not* to do), and — when repairing an existing suite — find and delete the tests that cannot fail. Use whenever you are writing, extending, reviewing or repairing tests, when someone quotes a coverage percentage as evidence of quality, or when a green suite shipped a bug anyway."
---

# Writing tests that can fail

A test has one job: **fail when the behaviour is wrong**. Covering a line is not that job.

The default failure of test-writing is invisible, because a broken test doesn't error — it passes.
It passes today, it passes after the bug is introduced, and it passes in CI during the incident.
Coverage makes it worse: it measures whether a line *executed*, which a test with no real
assertion does perfectly.

Two separate things can go wrong, and they need different tools:

- **The tests you wrote don't bite.** Loose matchers, values that can't discriminate, expectations
  copied from the implementation. Fixed by the assertion discipline below.
- **You didn't think to test it.** No amount of scrutinising the tests you have will surface a
  behaviour you never considered. Fixed by the checklist below — the second half of this file.

## Before writing each test, name the bug

One sentence: *the bug this catches is …*

- "returns the discount when the total is exactly at the threshold" → catches `>` written for `>=`
- "rejects a token that expired one second ago" → catches an inverted comparison
- "leaves the input array unmodified" → catches an in-place sort

If you can't name a wrong implementation it would catch, you're about to write a test that can't
fail. Write a different one. This question is free and it prevents most of what follows.

Then name the test after the behaviour and its condition, not the function: when it goes red at
3am, that name is the whole diagnosis.

## Pick values that a wrong formula can't fake

This is where most silent test failure actually comes from, and it is nearly free to get right.

Zero, one, and equal values make wrong arithmetic accidentally correct. At `t = 0`,
`oldest + window - now` and `window - now` agree. With a limit of 1, "oldest hit" and "newest hit"
are the same hit. With one element, "keeps the first" and "keeps the last" are indistinguishable.
A test built from those values passes against both the right implementation and a whole family of
wrong ones.

So: start clocks at an odd nonzero instant; use collections of two or three when position or count
matters; make every field of an expected object a different value; use inputs where the arguments
can't be swapped without changing the answer.

Then pick from the boundaries: zero, one, many; empty string, empty array; exactly at the limit and
one either side; negative and non-integer; `null` vs `undefined` vs missing; duplicates;
already-sorted and reversed. Two tests chosen this way beat ten that walk the same path.

## Assert the whole value, as a literal

**Write expected values out.** If the expectation is computed by the same expression as the
implementation, a wrong implementation produces a matching wrong expectation:

```js
expect(format(1234)).toBe(`$${(1234 / 100).toFixed(2)}`)   // agrees with any formula the code uses
expect(format(1234)).toBe("$12.34")                        // an independent claim
```

**Assert the whole object** (`toStrictEqual({...})`) rather than picking fields. A field you don't
mention is a field no test protects, and one diff shows everything that moved.

**Assert what the caller observes** — the return value, the thrown error, the state afterwards —
not how it was computed. A test asserting `db.insert` was called with particular arguments goes red
when someone batches two inserts (behaviour unchanged) and stays green when the row goes to the
wrong table (behaviour broken). Assert on collaborator calls only when the call *is* the effect: an
email sent, a payment charged. (One exception below, under *consumed exactly once*.)

**Assert precisely enough to fail.** `toBeDefined`, `toBeTruthy`, `not.toThrow` and
`expect.any(String)` are satisfied by most wrong answers. If you reached for a loose matcher because
a value is unpredictable — a timestamp, a generated id — inject or freeze it instead.

## The tests nobody thinks to write

Every one of these is an obligation with no visible return value, which is why they're missed. In
practice these are where the surviving bugs live.

1. **It doesn't mutate what it doesn't own.** The caller's array comes back unsorted, their object
   unedited. Freeze the input (`Object.freeze`) or snapshot it and assert it survived.
2. **Paired operations agree at the shared boundary.** `peek`/`take`, `parse`/`format`, `has`/`get`,
   `canX`/`doX` — test them at the *same* edge case, not separately in the easy middle. Two
   functions that each look right and disagree by one is a classic.
3. **Effectful collaborators are consumed the right number of times.** A clock or RNG read twice in
   one operation can hand back two different answers mid-computation. Here the read count *is*
   observable behaviour: use a fake that advances on every call, and the disagreement surfaces as a
   wrong value — no call-counting needed.
4. **Cleanup handles many, not one.** Eviction, retries, batch deletes: test with several expired
   entries, not one, or "removes the oldest" passes for "removes all expired".
5. **It doesn't do more than it was asked.** No extra separator accepted, no case-folding nobody
   requested, no silent coercion. Over-permissiveness never shows up in a happy-path test.
6. **Doing it twice is safe** where the operation claims to be idempotent or has a "no" answer:
   when the answer is no, assert that *nothing was written*.

## When to prove a test red

A test you have never seen fail is an unverified claim. Making it fail is mandatory in three cases,
and cheap in each:

1. **Fixing a reported bug** — write the test first, watch it fail against the unfixed code, then
   fix. Free, and it's the only proof the test covers the bug.
2. **Repairing or extending an existing suite** — before trusting inherited tests, break the code
   they claim to cover and see which ones go red. The ones that don't are decoration: delete them
   and say why. This is the fastest way to find tests that only look like tests, and inherited
   suites are where they live.
3. **A test whose failure you can't predict** — a complex harness, fake timers, a mocked boundary.
   Mutate once and confirm the failure message points at the behaviour and not at the harness.

For a fresh test on code you just read, asserting a literal whole value on a directly-computed
result, mutation mostly re-confirms what the assertion already guarantees. Spend that budget on one
more test from the checklist above instead — a hole in what you *thought to test* is never found by
mutating what you already wrote.

Report what you actually verified, and what you left uncovered.

## Async, briefly

An assertion that runs after the test finished cannot fail it. Return or await every promise:
`await expect(verify("bad")).rejects.toThrow(...)`. The shapes to watch are an un-awaited `.then()`
holding the assertion, `array.forEach(async ...)` (promises dropped), a `.resolves`/`.rejects` chain
with no `await`, and an `async` test body containing no `await` at all. Details in
`references/flaws.md` #2.

## Coverage, briefly

Coverage says which lines *ran*, never whether anything was checked, and it is blind to the biggest
category of defect: **code that isn't there**. A missing null check has no line to leave uncovered,
so a file missing three of them sits at 100% forever. Read uncovered lines as a question, not a
quota, and never delete a guard clause to make an unreachable branch coverable — that trades a loud
failure for silent corruption. See `references/flaws.md` #3, #4 and #10.

## Before you call it done

- Every test names a behaviour, and you can say what bug it catches.
- Expected values are literals; whole objects asserted, not single fields.
- Inputs are chosen so a wrong formula can't coincidentally pass.
- You worked the negative-space checklist and can say which items don't apply.
- Every promise is awaited. No `.only` left behind, no `.skip` you meant to revisit.
- Nothing depends on the clock, locale, timezone, randomness, network, or test order.

If a test fails and you can't see why, **don't loosen the assertion to make it pass.** The
assertion is the only part of the test with any value.

## A mechanical pass, before you call it done

`scripts/test-smells.mjs` reads JS/TS test files and reports the flaws that are decidable from the
text alone — a test with no assertion, an assertion stranded in an un-awaited promise, an `async`
callback dropped into `forEach`, a `.only` left behind, matchers that cannot fail, a clock or
`Math.random()` in a test:

```
node <skill>/scripts/test-smells.mjs path/to/tests   # exits 1 on any error-level finding
```

Errors are things that are simply wrong. Warnings are worth a look and sometimes fine. It reads
text, so it cannot tell you whether a test checks the *right* thing — that is what the rest of this
file is for. Use it as the last sweep, not the standard.

## The catalogue

`references/flaws.md` has the twelve ways a test ends up unable to fail, each with the version that
looks fine in review and the fix. Read it when repairing someone else's suite, or when a green suite
missed a bug and you need to work out how.
