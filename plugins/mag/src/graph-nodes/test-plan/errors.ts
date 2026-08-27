import { Data } from "effect"

/** No criteria means nothing to plan against: an unfit input, refused before any session is spent. */
export class TestPlanAcsEmpty extends Data.TaggedError("TEST_PLAN_ACS_EMPTY")<{}> {}
