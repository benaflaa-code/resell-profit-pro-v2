import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [html, css, js, worker, hosting] = await Promise.all([
  readFile(resolve(root, "dist/index.html"), "utf8"),
  readFile(resolve(root, "dist/styles.css"), "utf8"),
  readFile(resolve(root, "dist/app.js"), "utf8"),
  readFile(resolve(root, "worker/index.js"), "utf8"),
  readFile(resolve(root, ".openai/hosting.json"), "utf8")
]);

await mkdir(resolve(root, "dist/server"), { recursive: true });
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
const bundle = `const HTML = ${JSON.stringify(html)};\nconst CSS = ${JSON.stringify(css)};\nconst APP_JS = ${JSON.stringify(js)};\n${worker}`;
await writeFile(resolve(root, "dist/server/index.js"), bundle);
await writeFile(resolve(root, "dist/.openai/hosting.json"), hosting);
console.log("Built Sites Worker with embedded app assets");
