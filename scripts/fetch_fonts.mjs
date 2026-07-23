/**
 * Build-time font fetcher: downloads self-hosted Fira Sans (400-700) and
 * Fira Code (500-700) woff2 files (latin + latin-ext subsets) from Google
 * Fonts into public/fonts/ and prints the @font-face CSS for styles.css.
 * Zero runtime deps; the app never requests fonts externally. npm run fonts.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@400;500;600;700&display=swap";
const WANTED_SUBSETS = new Set(["latin", "latin-ext"]);
const OUT_DIR = "public/fonts";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const res = await fetch(CSS_URL, { headers: { "User-Agent": UA } });
if (!res.ok) throw new Error(`fonts css2 fetch failed: ${res.status}`);
const css = await res.text();

// Blocks look like: /* latin */ @font-face { font-family: 'Fira Sans'; font-style: normal; font-weight: 400; src: url(https://...woff2) format('woff2'); unicode-range: ...; }
const blockRe = /\/\* ([a-z-]+) \*\/\s*@font-face\s*\{([^}]+)\}/g;
const files = [];
let m;
while ((m = blockRe.exec(css)) !== null) {
  const subset = m[1];
  if (!WANTED_SUBSETS.has(subset)) continue;
  const body = m[2];
  const family = /font-family: '([^']+)'/.exec(body)?.[1];
  const weight = /font-weight: (\d+)/.exec(body)?.[1];
  const url = /url\((https:[^)]+\.woff2)\)/.exec(body)?.[1];
  const range = /unicode-range: ([^;]+);/.exec(body)?.[1];
  if (!family || !weight || !url || !range) continue;
  const slug = family.toLowerCase().replace(/\s+/g, "-");
  const name = `${slug}-${weight}${subset === "latin" ? "" : `-${subset}`}.woff2`;
  files.push({ family, weight, subset, url, range, name });
}

if (files.length === 0) throw new Error("no woff2 URLs parsed — Google css2 format changed?");
mkdirSync(OUT_DIR, { recursive: true });
for (const f of files) {
  const r = await fetch(f.url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`download failed ${f.url}: ${r.status}`);
  writeFileSync(`${OUT_DIR}/${f.name}`, Buffer.from(await r.arrayBuffer()));
  console.log(`wrote ${OUT_DIR}/${f.name}`);
}

console.log("\n@font-face CSS for styles.css:\n");
for (const f of files) {
  console.log(
    `@font-face {\n  font-family: '${f.family}';\n  font-style: normal;\n  font-weight: ${f.weight};\n  font-display: swap;\n  src: url('/fonts/${f.name}') format('woff2');\n  unicode-range: ${f.range};\n}`,
  );
}
console.log(`\n${files.length} files`);
