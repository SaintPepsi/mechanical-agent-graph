# The catalogue — twelve ways a test ends up unable to fail

Each entry: the shape as it appears in review, why it survives, and what to do instead. They are
ordered by how much damage they do, not how often they appear.

1. [Assertion-free tests](#1-assertion-free-tests)
2. [Assertions stranded in un-awaited async](#2-assertions-stranded-in-un-awaited-async)
3. [Line coverage standing in for input coverage](#3-line-coverage-standing-in-for-input-coverage)
4. [The blind spot: code that isn't there](#4-the-blind-spot-code-that-isnt-there)
5. [Change-detector tests](#5-change-detector-tests)
6. [Tautological tests](#6-tautological-tests)
7. [Asserting on your own stub](#7-asserting-on-your-own-stub)
8. [Mocks that drift from reality](#8-mocks-that-drift-from-reality)
9. [Assertions that cannot fail](#9-assertions-that-cannot-fail)
10. [Design damage from chasing the last 5%](#10-design-damage-from-chasing-the-last-5)
11. [Shared state and order dependence](#11-shared-state-and-order-dependence)
12. [Non-determinism](#12-non-determinism)

---

## 1. Assertion-free tests

```js
it("processes the order", () => {
  processOrder(order)          // 100% coverage of processOrder. Zero knowledge gained.
})

it("returns a user", () => {
  expect(getUser(1)).toBeDefined()   // passes for {}, for a stub, for the wrong user
})
```

**Why it survives:** it looks like work, it makes the coverage number move, and it never goes red
— so nobody ever has a reason to open it again. Snapshot tests join this category the moment
someone starts regenerating them with `-u` instead of reading the diff.

**Instead:** assert the value. If you genuinely only care that it doesn't throw, say so in the
name (`"does not throw on an empty cart"`) and assert something about the result anyway — the
useful test is almost always one level further in.

## 2. Assertions stranded in un-awaited async

```js
it("rejects a bad token", () => {
  verify("bad").then(r => expect(r.ok).toBe(false))   // no await, no return
})
```

**Why it survives:** the test is green, not skipped, so no report flags it. The assertion resolves
after the test has already finished and its result goes nowhere.

Same family: `array.forEach(async x => { ... })` drops every promise; `expect(p).resolves.toBe(1)`
without `await`; an `async` test body containing no `await` at all; fake timers that are never
advanced.

**Instead:** `await expect(verify("bad")).rejects.toThrow(BadToken)`. Return or await every
promise, and use `for (const x of xs)` with `await` instead of `forEach`.

## 3. Line coverage standing in for input coverage

```js
function discount(total, isMember) {
  if (total > 100 && isMember) return total * 0.9
  return total
}

it("discounts", () => expect(discount(200, true)).toBe(180))
it("does not", () => expect(discount(50, false)).toBe(50))
```

100% line *and* branch coverage. Never tested `(200, false)` or `(50, true)`, and never tested
`total === 100` — the boundary where the off-by-one lives.

**Why it survives:** the coverage tool says the job is done, so nobody asks the next question.

**Instead:** choose inputs from the boundaries of the input space (zero/one/many, at the limit and
either side, empty, null vs undefined, duplicates), not from the shape of the code.

## 4. The blind spot: code that isn't there

```js
function applyRefund(order, amount) {
  order.refunded += amount   // no check that amount <= order.total
  return order               // no check that it isn't already refunded
}
```

100% covered, forever, no matter how many tests you add — the missing validation contributes no
lines, so there is nothing to leave uncovered.

**Why it survives:** this is the structural limit of coverage as a metric, and the metric is
usually the only thing anyone looks at.

**Instead:** derive tests from the specification and the failure cases, not from the code in front
of you. Ask what inputs *should* be rejected, and check that they are.

## 5. Change-detector tests

```js
it("saves the user", () => {
  createUser(db, "ian")
  expect(db.insert).toHaveBeenCalledWith("users", { name: "ian" })
  expect(db.commit).toHaveBeenCalledTimes(1)
})
```

Batch two inserts or switch to an upsert — identical behaviour, red test. Write to the wrong
table — broken behaviour, green test.

**Why it survives:** it is easy to write from the implementation, and it does fail sometimes,
which reads as sensitivity rather than as coupling.

**The tell:** *"I changed behaviour X and forty tests broke, and none of them found a bug."* A
test that can only fail during a refactor is a tax with no benefit.

**Instead:** assert the observable outcome — read the row back, assert the returned value, assert
the state the next caller sees. Reserve call assertions for cases where the call *is* the effect
(an email sent, a payment charged).

## 6. Tautological tests

```js
it("formats the price", () => {
  expect(format(1234)).toBe(`$${(1234 / 100).toFixed(2)}`)
})
it("sums", () => expect(sum(a, b)).toBe(a + b))
```

**Why it survives:** it reads as rigorous — it even looks parameterised and general.

But if the implementation's formula is wrong, the expectation is wrong in exactly the same way.
The test asserts that the code equals itself.

**Instead:** hardcode `"$12.34"`. A literal is an independent oracle; a re-derived expression is
not. Where the mapping is genuinely too large to write out, assert a *property* the
implementation cannot trivially satisfy (`parse(format(x)) === x`, output is a permutation of
input and is sorted) rather than restating the formula.

## 7. Asserting on your own stub

```js
mockApi.getUser.mockResolvedValue({ name: "ian" })
const result = await loadProfile()
expect(result.name).toBe("ian")   // tests the mocking library
```

**Why it survives:** it produces a specific-looking assertion on a specific-looking value, and the
value does flow through the code under test — just without anything about it being checked.

**Instead:** assert the part the code under test actually *did* — the transformation, the
selection, the error mapping. If the answer is "nothing, it passes the value straight through",
that path may not need a unit test at all.

## 8. Mocks that drift from reality

```js
vi.mock("./api", () => ({ fetchUser: () => ({ id: 1, name: "ian" }) }))
// The real endpoint returns { id, profile: { name } } and 404s for deleted users.
```

Every test passes. Nothing works.

**Why it survives:** unit tests structurally cannot catch integration mismatch, and a high
coverage number makes people believe they bought insurance they didn't buy.

**Instead:** build fakes from the real contract (a recorded response, a shared schema, a type
generated from the API), keep a handful of tests that hit the real boundary, and be suspicious of
any mock whose shape you wrote from memory.

## 9. Assertions that cannot fail

```js
expect(result).toEqual(expect.objectContaining({ id: 1 }))  // ignores nine wrong fields
expect(items).toEqual(expect.any(Array))
expect(rows.length).toBeGreaterThanOrEqual(0)               // true of every array
expect(a).toEqual(b)                                        // same object, both sides
expect(rows).toEqual([x, y])                                // query has no ORDER BY — flakes, then gets .sort()ed into meaninglessness
```

**Why it survives:** each one is a real matcher doing a real comparison. The comparison just
happens to be one nothing can fail.

**Instead:** assert the whole value with `toStrictEqual` and a literal. If a field is genuinely
unpredictable, control it (inject the clock, inject the id generator) rather than matching it
loosely.

## 10. Design damage from chasing the last 5%

The final few percent is where the incentive turns actively harmful:

- Exporting internals or widening visibility purely so a test can reach them.
- Adding injection seams nothing else needs, so an unreachable branch can be forced.
- **Deleting defensive code because it's unreachable** — the `default:` case, the
  `if (!conn) throw`, the invariant guard. It is uncoverable *because* it is an invariant.
  Removing it to get a green report converts a loud failure into silent corruption later.
- `/* istanbul ignore next */` sprinkled until the number looks right.
- Hundreds of trivial tests over getters and DTOs, which make the dozen tests that matter
  unfindable and the suite slow enough that people stop running it.

**Instead:** treat uncovered lines as a question, not a quota, and let some stay uncovered with a
reason. If you want to know whether the suite is real, mutate the source and count survivors.

## 11. Shared state and order dependence

Tests that pass as a suite and fail alone, or pass in one order and fail in another, because
module-level state, a shared database row, or a mock left over from an earlier test is doing the
work.

**Why it survives:** CI runs them in the same order every time, so it stays green until the day
someone parallelises the suite or runs one file.

**The tell:** putting `.only` on a red test makes it green.

**Instead:** build fixtures fresh per test, reset mocks between tests, and never let one test
depend on another's writes. Run the file alone, and in a random order, before trusting it.

## 12. Non-determinism

`Date.now()`, `new Date()`, `Math.random()`, `toLocaleString()`, real network, real filesystem
paths, timezone-dependent formatting.

**Why it survives:** it is green on your machine, in your timezone, this month.

**Instead:** inject the clock and the random source, or freeze them. Pass fixed instants. Assert
in UTC with an explicit format. If a test needs the network, it is an integration test and should
be labelled as one so its flakiness doesn't get charged to the unit suite.
