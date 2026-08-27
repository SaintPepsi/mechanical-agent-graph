import { describe, expect, test } from "bun:test"
import { renderChecklist } from "mag/skills/design/compose"
import { DESIGN_DESTINATION, writeAndConfirm } from "mag/skills/design/write-and-confirm"

describe("write-and-confirm", () => {
  // Both steps name the one destination constant, so the dispatching node's single
  // `replaceAll(DESIGN_DESTINATION, absolutePath)` rewrites the confirm step too.
  test("the write step and the confirm step both carry DESIGN_DESTINATION, and the confirm step tells the session not to run git", () => {
    const rendered = renderChecklist(null, writeAndConfirm.steps!)
    const [write, confirm] = rendered.split("\n").filter((line) => line.includes(DESIGN_DESTINATION))
    expect(write).toContain("**Write design doc**")
    expect(confirm).toContain("**Confirm the design doc**")
    expect(confirm).toContain("do not run git")
  })
})
