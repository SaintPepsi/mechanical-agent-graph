---
name: writing-tests
description: "Make unit tests able to fail: choose inputs that tell correct code apart from plausibly-wrong code, assert whole values as literals, cover the contract's negative space (what the code promises *not* to do), and — when repairing an existing suite — find and delete the tests that cannot fail. Use whenever you are writing, extending, reviewing or repairing tests, when someone quotes a coverage percentage as evidence of quality, or when a green suite shipped a bug anyway."
---

# Writing tests that can fail

A test has one job: fail when the behaviour is wrong.
Reasons, examples and failure modes: `references/flaws.md`.

## Name the bug

- Say what wrong implementation each test catches.
- If you can't name one, write a different test.
- Name the test after the behaviour and its condition, not the function.

## Choose values

Zero, one, and equal values make wrong arithmetic accidentally right: at `t = 0`, `oldest + window - now` equals `window - now`, and with a limit of 1 the oldest and newest hit are the same hit.

- Start clocks at an odd nonzero instant.
- Use two or three elements when position or count matters.
- Give every field of an expected object a different value.
- Choose arguments that can't be swapped without changing the answer.
- Cover zero/one/many, empty, the limit and either side, negative, non-integer, `null` vs `undefined` vs missing, duplicates, sorted, reversed.

## Assert

- Write expected values as literals.
- Assert whole objects with `toStrictEqual`, not single fields.
- Assert the return value, the thrown error, or the resulting state.
- Assert a collaborator call only when the call is the effect.
- Never assert with `toBeDefined`, `toBeTruthy`, `not.toThrow` or `expect.any`.
- Inject or freeze an unpredictable value instead of matching it loosely.

## Cover the negative space

- Freeze the input and assert it survived.
- Test paired operations at the same boundary: `peek`/`take`, `parse`/`format`, `has`/`get`, `canX`/`doX`.
- Use a clock or RNG fake that advances on every call, so a second read inside one operation shows up as a wrong value.
- Expire several entries at once, or "removes the oldest" passes for "removes all expired".
- Assert that nothing is silently widened: no extra separator accepted, no case folded, no value coerced.
- Assert a repeated call is safe and a "no" answer writes nothing.

## Prove it red

- Bug fix: write the test first and watch it fail against the unfixed code.
- Inherited suite: break the code it covers and delete the tests that stay green.
- Unpredictable failure: mutate once and confirm the message names the behaviour.
- Otherwise skip mutation.
- Report what you verified and what you left uncovered.

## Async

- Return or await every promise.
- Check for un-awaited `.then()`, `forEach(async …)`, `.resolves` without `await`, and `async` bodies without `await`.

## Coverage

- Read uncovered lines as a question, not a quota.
- Never delete a guard clause to make a branch coverable.

## Done

- Every test names a behaviour and a bug it catches.
- Expected values are literals and whole objects.
- No input lets a wrong formula pass by coincidence.
- You worked the negative-space list and can say which items don't apply.
- Every promise is awaited.
- No `.only` or `.skip` is left behind.
- Nothing depends on clock, locale, timezone, randomness, network or test order.
- Run `node <skill>/scripts/test-smells.mjs <path>` and clear every error.

Never loosen an assertion to make a red test pass.
