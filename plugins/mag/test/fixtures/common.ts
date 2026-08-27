import { Schema } from "effect"

// A single harmless flag rather than an empty struct: an empty-record input schema is an
// awkward edge case for the CLI flag layer to build a command from, unrelated to any node's
// own behaviour, so this fixture avoids it entirely.
export const TriggerInput = Schema.Struct({ trigger: Schema.Boolean })
export const EmptySuccess = Schema.Struct({})
