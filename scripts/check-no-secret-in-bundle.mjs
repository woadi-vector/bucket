#!/usr/bin/env node
/**
 * Fails if a secret reached anything the browser downloads.
 *
 * Phase 3's checkpoint is "no key appears anywhere in client bundle output". This is easy to
 * get wrong by accident — one `import.meta.env.NEBIUS_API_KEY`, or importing a server module
 * from a component, and the key is inlined into a JS chunk and served to everyone.
 *
 * Run after `npm run build`:
 *   node scripts/check-no-secret-in-bundle.mjs
 *
 * The secret's value is read but never printed. Exit code 1 means a leak.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = ".output/public";
const SECRET_NAMES = ["NEBIUS_API_KEY"];

function loadSecrets() {
  const found = new Map();
  for (const name of SECRET_NAMES) {
    if (process.env[name]?.trim()) found.set(name, process.env[name].trim());
  }
  for (const file of [".dev.vars", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw.trim().replace(/^["']|["']$/g, "");
      if (SECRET_NAMES.includes(key) && value && !found.has(key)) found.set(key, value);
    }
  }
  return found;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(CLIENT_DIR)) {
  console.error(`${CLIENT_DIR} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const secrets = loadSecrets();
if (secrets.size === 0) {
  console.error("No secrets configured, so there is nothing to check for. Set NEBIUS_API_KEY.");
  process.exit(1);
}

const files = walk(CLIENT_DIR);
const leaks = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) leaks.push({ file, name });
    // Also catch a build that inlined the *name* into client code, which usually means
    // someone reached for import.meta.env and got an empty string today, a real key later.
    if (/\.(js|mjs|cjs)$/.test(file) && text.includes(`${name}`)) {
      leaks.push({ file, name: `${name} (identifier present in client JS)` });
    }
  }
}

console.log(`Scanned ${files.length} files in ${CLIENT_DIR} for ${secrets.size} secret(s).`);

if (leaks.length > 0) {
  console.error("\nLEAK DETECTED — do not deploy:");
  for (const l of leaks) console.error(`  ${l.name} in ${l.file}`);
  process.exit(1);
}

console.log("Clean: no secret value or name appears in client output.");
