import { Data } from "effect"

/** An empty path list is an unfit input: a probe over nothing has no verdict to give a `when`. */
export class DetectJsTestsNoPaths extends Data.TaggedError("DETECT_JS_TESTS_NO_PATHS")<{}> {}
