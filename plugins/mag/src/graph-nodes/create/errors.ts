import { Data } from "effect"

/**
 * The name failed `[a-z][a-z0-9]*(-[a-z0-9]+)*`, or it matched the pattern but its camelCase
 * form is a reserved word or collides with an identifier the scaffold's own templates bind
 * (e.g. `make`, `test`) -- `reason` tells the two apart.
 */
export class InvalidNodeName extends Data.TaggedError("CREATE_INVALID_NODE_NAME")<{
  readonly name: string
  readonly pattern: string
  readonly reason: string
}> {}

/** The description was empty, multiline, or carried control characters. */
export class InvalidDescription extends Data.TaggedError("CREATE_INVALID_DESCRIPTION")<{
  readonly reason: string
}> {}

/** The node directory already existed. */
export class NodeAlreadyExists extends Data.TaggedError("CREATE_NODE_ALREADY_EXISTS")<{
  readonly name: string
  readonly directory: string
}> {}

/** Any other I/O failure creating or writing the node directory. */
export class ScaffoldFailed extends Data.TaggedError("CREATE_SCAFFOLD_FAILED")<{
  readonly directory: string
  readonly detail: string
}> {}
