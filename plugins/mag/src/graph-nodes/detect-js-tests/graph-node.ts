import { Effect, Schema } from "effect"
import { DetectJsTestsNoPaths } from "mag/graph-nodes/detect-js-tests/errors"
import { make } from "mag/runtime/graph-node.definition"

/** The extensions `test-smells`' reader understands: JavaScript and TypeScript, any module flavour. */
const JS_TEST = /\.[cm]?[jt]sx?$/

/**
 * A mechanical probe in `detect-effect`'s shape, guarding `test-smells` through `runtime/when.ts`:
 * `matched` when any test path is a JS/TS file, with those paths as the evidence. Pure, no read:
 * the extension is the whole question, because the checker it guards reads text by that rule too.
 */
export const detectJsTests = make({
  name: "detect-js-tests",
  description: "Probe whether any test path is a JS/TS file the test-smells reader can inspect.",
  input: Schema.Struct({ testPaths: Schema.Array(Schema.String) }),
  success: Schema.Struct({ matched: Schema.Boolean, paths: Schema.Array(Schema.String) }),
  run: (input) => {
    if (input.testPaths.length === 0) return Effect.fail(new DetectJsTestsNoPaths())
    const paths = input.testPaths.filter((path) => JS_TEST.test(path))
    return Effect.succeed({ matched: paths.length > 0, paths })
  }
})
