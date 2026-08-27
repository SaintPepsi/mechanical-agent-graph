import { Effect, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { EmptySuccess } from "./common"

/**
 * The ONLY fixture that produces a genuine `outcome: "interrupt"` close
 * event. Every other fixture (`echo`/`boom`/`explode`/`throws`) completes in milliseconds — there
 * is nothing for a test to interrupt — and sending a signal to the child process from a test is
 * not portable: Windows has no catchable `SIGINT` delivered to a child, so the span finalizer
 * that writes the close event would never run. Instead, the interrupt outcome is produced by a
 * fixture that interrupts itself, not by a signal sent to the child.
 *
 * `run` waits out the given hold, then interrupts its own fiber. `Effect.withSpan`'s finalizer
 * sees that as a genuine interruption — the identical machinery a real Ctrl-C exercises through
 * `NodeRuntime.runMain`'s installed `SIGINT`/`SIGTERM` handler.
 *
 * `input` is one primitive number field (`Schema.Int`, the same shape `echo`'s `maxRetries`
 * already proves `deriveFlagSpecs` accepts) — the identical primitives-only constraint that binds
 * `secret.ts`. `success` is `EmptySuccess`: this node never produces a success value.
 *
 * Second reader: a mandatory hand-run check invokes this fixture directly to eyeball the
 * `mag: [halt] INTERRUPT 0.3s` console line against its fixed template. The hold (in
 * milliseconds) exists for two readers: it keeps that console line's duration non-zero for the
 * eyeball check, and it gives a human a window to press Ctrl-C during the run, as an optional
 * second route. Do not delete this fixture as "a node that does nothing" — no other fixture can
 * stand in for it.
 */
const HaltInput = Schema.Struct({
  holdMs: Schema.Int,
})

export const halt = make({
  name: "halt",
  description: "Waits out the given hold in milliseconds, then interrupts its own fiber.",
  input: HaltInput,
  success: EmptySuccess,
  run: (input) => Effect.sleep(input.holdMs).pipe(Effect.andThen(Effect.interrupt)),
})
