#!/usr/bin/env node
/**
 * Token Factory probe — Phase 3, step one.
 *
 * The plan says: before wiring anything to the UI, call the API directly and print the raw
 * response, because there is a reported issue that the Nemotron models return their output in
 * `reasoning_content` with `content` empty, and do not support tool calls through the
 * OpenAI-compatible wrapper. If that reproduces, a parser reading only
 * `choices[0].message.content` silently gets nothing, and a small max_tokens budget is eaten
 * by the reasoning trace before any answer is emitted.
 *
 * This script answers those questions and writes every raw response to ./probe-output/ so the
 * findings can be quoted in the README and the Most Valuable Feedback submission.
 *
 * Usage:
 *   node scripts/probe-token-factory.mjs
 *
 * The key is read from NEBIUS_API_KEY, or from .dev.vars if that is not set. It is never
 * printed, never logged, and never written to probe-output.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1";
const OUT_DIR = "probe-output";

// ---------------------------------------------------------------- key loading

function loadKey() {
  if (process.env.NEBIUS_API_KEY?.trim()) return process.env.NEBIUS_API_KEY.trim();

  for (const file of [".dev.vars", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?NEBIUS_API_KEY\s*=\s*(.*)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    }
  }
  return null;
}

const KEY = loadKey();
if (!KEY) {
  console.error(
    [
      "No API key found.",
      "",
      "Put it in .dev.vars (gitignored):",
      "    Copy-Item .dev.vars.example .dev.vars",
      "    # then edit .dev.vars and set NEBIUS_API_KEY=...",
      "",
      "or set it for one command:",
      '    $env:NEBIUS_API_KEY = "..."; node scripts/probe-token-factory.mjs',
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`Key loaded (${KEY.length} chars). It is not printed anywhere in this output.`);

// ---------------------------------------------------------------- helpers

mkdirSync(OUT_DIR, { recursive: true });

function save(name, data) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
  return path;
}

async function call(path, init = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { ok: res.ok, status: res.status, json, text, ms: Date.now() - started };
}

const rule = (t) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);

/** Redact the key if it ever appears in an error body. Belt and braces. */
const scrub = (s) => (typeof s === "string" ? s.split(KEY).join("<REDACTED>") : s);

const findings = {};

// ---------------------------------------------------------------- 1. models

rule("1. GET /models  — the plan says verify ids, never assume namespacing");

const models = await call("/models");
console.log(`status ${models.status} in ${models.ms}ms`);

let modelIds = [];
if (models.ok && Array.isArray(models.json?.data)) {
  modelIds = models.json.data.map((m) => m.id).sort();
  save("01-models.json", models.json);
  console.log(`${modelIds.length} models available. Nemotron matches:`);
  const nemotron = modelIds.filter((id) => /nemotron/i.test(id));
  for (const id of nemotron) console.log(`   ${id}`);
  if (nemotron.length === 0) console.log("   (none — check namespacing)");
  findings.modelIds = nemotron;
} else {
  console.log("FAILED:", scrub(models.text).slice(0, 600));
  save("01-models-error.txt", scrub(models.text));
  findings.modelsError = models.status;
}

// Prefer ids the server actually reports; fall back to the plan's guesses.
const pick = (re, fallback) => modelIds.find((id) => re.test(id)) ?? fallback;
const NANO = pick(/nano/i, "NVIDIA-Nemotron-3-Nano-30B-A3B");
const ULTRA = pick(/ultra/i, "Llama-3_1-Nemotron-Ultra-253B-v1");
console.log(`\nUsing nano:  ${NANO}\nUsing ultra: ${ULTRA}`);

// ---------------------------------------------------------------- 2. the big question

const VERDICT_PROMPT = [
  {
    role: "system",
    content:
      'Reply with JSON only: {"verdict":"want"|"need","confidence":0.0-1.0,"reasoning":"one sentence"}',
  },
  {
    role: "user",
    content:
      "Purchase: noise-cancelling headphones, $240. They labelled it: need. They decided on the spot. Is that label honest?",
  },
];

async function chatProbe(label, body, file) {
  rule(label);
  console.log(`model=${body.model} max_tokens=${body.max_tokens ?? "(default)"}`);
  const res = await call("/chat/completions", { method: "POST", body: JSON.stringify(body) });
  console.log(`status ${res.status} in ${res.ms}ms`);

  if (!res.ok) {
    console.log("FAILED:", scrub(res.text).slice(0, 800));
    save(file.replace(".json", "-error.txt"), scrub(res.text));
    return null;
  }

  save(file, res.json);
  const msg = res.json?.choices?.[0]?.message ?? {};
  const content = msg.content ?? "";
  const reasoning = msg.reasoning_content ?? "";
  const usage = res.json?.usage ?? {};

  console.log(`  finish_reason:        ${res.json?.choices?.[0]?.finish_reason}`);
  console.log(`  content:              ${content ? `${content.length} chars` : "EMPTY"}`);
  console.log(
    `  reasoning_content:    ${reasoning ? `${reasoning.length} chars` : "absent/empty"}`,
  );
  console.log(
    `  tokens:               prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
  );
  if (usage.completion_tokens_details) {
    console.log(`  completion details:   ${JSON.stringify(usage.completion_tokens_details)}`);
  }
  if (content) console.log(`\n  --- content ---\n${content.slice(0, 500)}`);
  if (reasoning) console.log(`\n  --- reasoning_content (first 500) ---\n${reasoning.slice(0, 500)}`);

  return { content, reasoning, usage, finish: res.json?.choices?.[0]?.finish_reason };
}

const tight = await chatProbe(
  "2. Nano, TIGHT max_tokens (256) — does the reasoning trace eat the budget?",
  { model: NANO, messages: VERDICT_PROMPT, max_tokens: 256, temperature: 0.2 },
  "02-nano-tight.json",
);

const generous = await chatProbe(
  "3. Nano, GENEROUS max_tokens (4096)",
  { model: NANO, messages: VERDICT_PROMPT, max_tokens: 4096, temperature: 0.2 },
  "03-nano-generous.json",
);

const jsonMode = await chatProbe(
  "4. Nano + response_format json_object — is structured output honoured?",
  {
    model: NANO,
    messages: VERDICT_PROMPT,
    max_tokens: 4096,
    temperature: 0.2,
    response_format: { type: "json_object" },
  },
  "04-nano-json-mode.json",
);

const ultra = await chatProbe(
  "5. Ultra (253B) — latency is the thing to watch here",
  { model: ULTRA, messages: VERDICT_PROMPT, max_tokens: 4096, temperature: 0.2 },
  "05-ultra.json",
);

// ---------------------------------------------------------------- 6. tool calls

rule("6. Tool calls through the OpenAI-compatible wrapper — reported not to work");

const tools = await call("/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: NANO,
    max_tokens: 1024,
    messages: [{ role: "user", content: "Record a verdict of 'want' with confidence 0.8." }],
    tools: [
      {
        type: "function",
        function: {
          name: "record_verdict",
          description: "Record the verdict",
          parameters: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["want", "need"] },
              confidence: { type: "number" },
            },
            required: ["verdict", "confidence"],
          },
        },
      },
    ],
  }),
});
console.log(`status ${tools.status} in ${tools.ms}ms`);
if (tools.ok) {
  save("06-tools.json", tools.json);
  const tc = tools.json?.choices?.[0]?.message?.tool_calls;
  console.log(tc ? `  tool_calls returned: ${JSON.stringify(tc).slice(0, 300)}` : "  NO tool_calls in response");
  findings.toolCalls = tc ? "supported" : "accepted but no tool_calls returned";
} else {
  save("06-tools-error.txt", scrub(tools.text));
  console.log("  REJECTED:", scrub(tools.text).slice(0, 400));
  findings.toolCalls = `rejected (HTTP ${tools.status})`;
}

// ---------------------------------------------------------------- summary

rule("FINDINGS");

const verdictOn = (p) =>
  !p ? "call failed" : p.content ? "content populated" : p.reasoning ? "EMPTY content, answer in reasoning_content" : "both empty";

findings.reasoningContentQuirk = verdictOn(generous);
findings.tightBudget = tight
  ? `finish_reason=${tight.finish}, content ${tight.content ? "present" : "EMPTY"}`
  : "call failed";
findings.jsonMode = jsonMode ? (jsonMode.content ? "honoured" : "content still empty") : "call failed";
findings.ultraLatencyMs = ultra ? "see 05-ultra.json" : "call failed";

for (const [k, v] of Object.entries(findings)) {
  console.log(`  ${k.padEnd(24)} ${Array.isArray(v) ? v.join(", ") : v}`);
}

save("00-findings.json", findings);
console.log(`\nRaw responses written to ./${OUT_DIR}/ (gitignored).`);
console.log("No key material is present in any of those files.");
