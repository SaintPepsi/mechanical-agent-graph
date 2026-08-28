import { normalizeContacts } from "./src/normalize"
const batches = [
  [],
  [{ email: "a@x.com" }],
  [{ email: " A@X.com ", name: " Ian ", tags: "a, b ,,A" }, { email: "a@x.com", name: "Ian H", tags: "c,b" }],
  [{ email: "  " }, { name: "no email" }, { email: "" }],
  [{ email: "z@x.com", tags: "one;two, three" }, { email: "y@x.com", tags: "" }],
  [{ email: "d@x.com", name: "", tags: "VIP,vip,Vip" }],
  [{ email: "e@x.com", tags: " , , " }, { email: "E@X.COM", name: " Last " }]
]
const out = batches.map((rows) => {
  const before = JSON.stringify(rows)
  const report = normalizeContacts(rows as never)
  return { report, inputUnchanged: JSON.stringify(rows) === before }
})
console.log(JSON.stringify(out))
