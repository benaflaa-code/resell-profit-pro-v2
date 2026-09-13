import { access, readFile } from "node:fs/promises";

await access("dist/server/index.js");
await access("dist/.openai/hosting.json");
const worker = await readFile("dist/server/index.js", "utf8");
if (!worker.includes("export default") || !worker.includes("async fetch")) {
  throw new Error("Worker entrypoint is invalid");
}
console.log("Artifact validation passed");
