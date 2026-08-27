// Test harness: same entry-point shape as src/cli.ts, composed with a `win32` platform value so
// the refusal fires without mutating the real `process.platform` of the process running the suite.
import { main } from "mag/runtime/run-cli"
import { fixtureRegistry } from "./fixtures/registry"

main(fixtureRegistry, undefined, "win32")
