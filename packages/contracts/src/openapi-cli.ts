import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../docs/api/openapi.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${out}`);
