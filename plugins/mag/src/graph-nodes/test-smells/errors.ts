import { Data } from "effect"

/**
 * A test path the caller named cannot be read. A sweep that silently skipped it would report a
 * clean file that was never inspected, so the read failure is the node's own failure instead.
 */
export class TestSmellsUnreadable extends Data.TaggedError("TEST_SMELLS_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}
