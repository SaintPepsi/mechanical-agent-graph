export const inputExamples = [{ ticket: "GH-98", maintainer: "SaintPepsi" }]
export const successExamples = [
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    body: "## Executive Summary\n\nA NUL byte reaching the artifact writer kills the run."
  },
  // Documents the rendered-comments body shape: maintainer comments block-quoted, a withheld count for the rest.
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    body: "## Executive Summary\n\nA NUL byte reaching the artifact writer kills the run." +
      "\n\n## Comments" +
      "\n\n### 2026-08-18T12:00:00Z" +
      "\n\n> Confirmed against the write boundary; the fix belongs there, not in the parser." +
      "\n\n_2 comments by other authors withheld._"
  }
]
