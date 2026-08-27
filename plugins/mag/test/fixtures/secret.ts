import { Effect, Redacted, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"

/**
 * The redacted field lives on `success`, NEVER on `input`. `deriveFlagSpecs`
 * (`schema-flags.ts`) maps every input field's AST tag
 * through `flagKindByAstTag` and fails the WHOLE CLI build with `UNSUPPORTED_INPUT_SCHEMA` for
 * anything that isn't `String`/`Number`/`Boolean` or a refinement of one — a `Schema.Redacted`
 * INPUT field would red every subprocess test in `fixtureRegistry`, not just this fixture's own.
 * Do not "fix" this by moving `token` onto `input`.
 *
 * Second reader: `tracing-sinks.test.ts`. This same fixture is run again there, through
 * `harness-cli-tracing.ts` with a file sink, to read the close event's `value` field back and assert
 * it literally reads `"<redacted>"` — the positive half that the console sink can never show (its
 * close line, per the fixed console templates, carries no encoded value at all). A shape change here
 * reds both files.
 */
const SecretInput = Schema.Struct({
  user: Schema.String,
})

const SecretSuccess = Schema.Struct({
  user: Schema.String,
  token: Schema.Redacted(Schema.String),
})

export const secret = make({
  name: "secret",
  description: "Succeeds with one success field wrapped in Schema.Redacted, to prove tracing never leaks it.",
  input: SecretInput,
  success: SecretSuccess,
  run: (input) => Effect.succeed({ user: input.user, token: Redacted.make("super-secret-token-value") }),
})
