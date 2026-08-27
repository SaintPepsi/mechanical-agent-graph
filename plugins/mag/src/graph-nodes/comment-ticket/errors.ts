import { Data } from "effect"

/** The file this node was asked to post doesn't exist — checked before anything is spawned, so this fails named rather than as a tracker usage error. */
export class CommentBodyMissing extends Data.TaggedError("COMMENT_BODY_MISSING")<{
  readonly path: string
}> {}

/** `gh`'s own documented authentication-required exit, 4 (`gh help exit-codes`): no tracker to post to. */
export class CommentTrackerUnreachable extends Data.TaggedError("COMMENT_TRACKER_UNREACHABLE")<{
  readonly ticket: string
  readonly detail: string
}> {}

/** Non-zero `gh issue comment` exit, or no trailing issue number to address (marked `exitCode: 0`) — carries the code rather than guessing at a meaning. */
export class CommentFailed extends Data.TaggedError("COMMENT_FAILED")<{
  readonly ticket: string
  readonly exitCode: number
  readonly detail: string
}> {}
