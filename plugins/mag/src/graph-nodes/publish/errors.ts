/**
 * `publish` mints no error of its own: its inferred `E` is exactly the union
 * `pushBranch.run`/`createPr.run` already produce, so these are re-exports, not new classes.
 */
export { PushRejected } from "mag/graph-nodes/push-branch/errors"
export { CreatePrFailed, UnsupportedHost } from "mag/graph-nodes/create-pr/errors"
