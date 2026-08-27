/**
 * `adversarial-review` mints no error of its own: its inferred `E` is exactly the union its parts
 * already produce, re-exported here. It returns escapes and routes nowhere itself.
 */
export { BreakNoSources } from "mag/graph-nodes/break/errors"
export { DetectJsTestsNoPaths } from "mag/graph-nodes/detect-js-tests/errors"
export {
  SeverityEscapesWriteFailed,
  SeverityRatingsIncomplete,
  SeverityRunRootMissing
} from "mag/graph-nodes/judge-severity/errors"
export { TestSmellsUnreadable } from "mag/graph-nodes/test-smells/errors"
export {
  VerifyEscapesMutationFailed,
  VerifyEscapesProbeWriteFailed,
  VerifyEscapesRestoreFailed,
  VerifyEscapesRunRootMissing,
  VerifyEscapesSuiteRed
} from "mag/graph-nodes/verify-escapes/errors"
