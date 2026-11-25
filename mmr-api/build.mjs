import { copyFileSync, mkdirSync } from "node:fs";

const dist = new URL("./dist/", import.meta.url);
mkdirSync(new URL("server/", dist), { recursive: true });
mkdirSync(new URL(".openai/", dist), { recursive: true });
copyFileSync(new URL("./worker/index.js", import.meta.url), new URL("server/index.js", dist));
copyFileSync(new URL("./.openai/hosting.json", import.meta.url), new URL(".openai/hosting.json", dist));
