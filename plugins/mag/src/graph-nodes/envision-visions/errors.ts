/**
 * `envision-visions` mints no error of its own (`build-under-review`'s own precedent): its
 * inferred `E` is exactly `envision-notation`'s union, re-exported. A route's own tag is what
 * reaches this composite's caller, whether on its first dispatch or after the one retry
 * `graph-node.ts`'s loop grants a `NotationVisionMissing` failure — a route still failing after
 * its retry fails the composite with that attempt's own error.
 */
export {
  NotationVisionBlocked,
  NotationVisionCommitFailed,
  NotationVisionCopyFailed,
  NotationVisionGitFailed,
  NotationVisionMissing,
  UnknownNotation
} from "mag/graph-nodes/envision-notation/errors"
