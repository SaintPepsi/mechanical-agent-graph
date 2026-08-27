export const inputExamples = [
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    body: "## Executive Summary\n\nA NUL byte reaching the artifact writer kills the run." +
      "\n\n## Acceptance Criteria\n\n**AC.01 - A NUL byte is stripped at the write boundary**"
  }
]
export const successExamples = [{ ticket: "GH-98", criteria: 1 }]
