/** Bun text imports (`with { type: "text" }`): a markdown module is its file content, verbatim. */
declare module "*.md" {
  const text: string
  export default text
}
