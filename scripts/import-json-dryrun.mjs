#!/usr/bin/env node
// Migration safety tool (SOL-98 Phase 1, red rule #9: "no blind auto-import").
//
// Reports what importing data/*.json into the configured Supabase project
// would do — BEFORE/AFTER row counts, duplicates (rows that already exist in
// the target DB and would be skipped, never overwritten), malformed entries
// (skipped, never imported), and a per-table summary. Writes NOTHING unless
// invoked with --apply, and even then refuses to run --apply if the dry run
// found any malformed entries.
//
// Usage:
//   node scripts/import-json-dryrun.mjs              # dry run (default, safe)
//   node scripts/import-json-dryrun.mjs --apply       # actually import, only
//                                                      # after a clean dry run
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (this
// script deliberately does NOT read .env.local itself — pass them via your
// shell so it's obvious which project you're pointing at). Never run this
// against production without first running it here, dry-run, against a
// staging project (red rule #10).
import { readFile } from "node:fs/promises";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const DATA_DIR = process.env.DRYRUN_DATA_DIR
  ? path.resolve(process.env.DRYRUN_DATA_DIR)
  : path.join(process.cwd(), "data");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function headers(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`${file}: malformed JSON — ${err.message}`);
  }
}

function validatePixelRecord(index, data) {
  const errors = [];
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) errors.push(`bad index "${index}"`);
  if (!data || typeof data !== "object") errors.push(`missing data object for index ${index}`);
  else if (typeof data.owner !== "string" || !data.owner) errors.push(`index ${index}: missing owner`);
  return errors;
}

async function fetchExistingIndices(table) {
  if (!SUPABASE_URL || !SERVICE_KEY) return new Set();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=index`, { headers: headers() });
  if (!res.ok) throw new Error(`could not read target table "${table}": HTTP ${res.status}`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.index));
}

async function fetchExistingSignatures() {
  if (!SUPABASE_URL || !SERVICE_KEY) return new Set();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/used_signatures?select=signature`, { headers: headers() });
  if (!res.ok) throw new Error(`could not read target table "used_signatures": HTTP ${res.status}`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.signature));
}

async function fetchExistingDocumentIds() {
  if (!SUPABASE_URL || !SERVICE_KEY) return new Set();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/documents?select=id`, { headers: headers() });
  if (!res.ok) throw new Error(`could not read target table "documents": HTTP ${res.status}`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.id));
}

async function report() {
  const summary = { pixels: null, documents: null, usedSignatures: null };
  const malformed = [];

  // --- pixels.json -> pixels table -----------------------------------
  const pixelsRaw = await readJson("pixels.json", {}).catch((e) => {
    malformed.push(e.message);
    return {};
  });
  const pixelEntries = Object.entries(pixelsRaw);
  for (const [index, data] of pixelEntries) {
    malformed.push(...validatePixelRecord(index, data));
  }
  const existingPixelIndices = await fetchExistingIndices("pixels");
  const validPixelIndices = pixelEntries
    .map(([index]) => Number(index))
    .filter((n) => Number.isInteger(n) && n >= 0);
  const dupPixels = validPixelIndices.filter((i) => existingPixelIndices.has(i));
  const newPixels = validPixelIndices.filter((i) => !existingPixelIndices.has(i));
  summary.pixels = {
    beforeInSource: pixelEntries.length,
    beforeInTarget: existingPixelIndices.size,
    wouldSkipAsDuplicate: dupPixels.length,
    wouldImport: newPixels.length,
    afterInTargetIfApplied: existingPixelIndices.size + newPixels.length,
  };

  // --- documents.json -> documents table ------------------------------
  const docsRaw = await readJson("documents.json", []).catch((e) => {
    malformed.push(e.message);
    return [];
  });
  const docs = Array.isArray(docsRaw) ? docsRaw : [];
  for (const d of docs) {
    if (!d || typeof d.id !== "string" || typeof d.owner !== "string") {
      malformed.push(`documents.json: malformed entry ${JSON.stringify(d).slice(0, 80)}`);
    }
  }
  const existingDocIds = await fetchExistingDocumentIds();
  const validDocs = docs.filter((d) => d && typeof d.id === "string");
  const dupDocs = validDocs.filter((d) => existingDocIds.has(d.id));
  const newDocs = validDocs.filter((d) => !existingDocIds.has(d.id));
  summary.documents = {
    beforeInSource: docs.length,
    beforeInTarget: existingDocIds.size,
    wouldSkipAsDuplicate: dupDocs.length,
    wouldImport: newDocs.length,
    afterInTargetIfApplied: existingDocIds.size + newDocs.length,
  };

  // --- used-signatures.json -> used_signatures table -------------------
  const sigsRaw = await readJson("used-signatures.json", []).catch((e) => {
    malformed.push(e.message);
    return [];
  });
  const sigs = Array.isArray(sigsRaw) ? sigsRaw.filter((s) => typeof s === "string" && s) : [];
  const existingSigs = await fetchExistingSignatures();
  const dupSigs = sigs.filter((s) => existingSigs.has(s));
  const newSigs = sigs.filter((s) => !existingSigs.has(s));
  summary.usedSignatures = {
    beforeInSource: sigs.length,
    beforeInTarget: existingSigs.size,
    wouldSkipAsDuplicate: dupSigs.length,
    wouldImport: newSigs.length,
    afterInTargetIfApplied: existingSigs.size + newSigs.length,
  };

  return { summary, malformed, newPixels, pixelsRaw, newDocs, newSigs };
}

async function apply(plan) {
  const results = { pixels: { inserted: 0, errors: [] }, documents: { inserted: 0, errors: [] }, signatures: { inserted: 0, errors: [] } };

  if (plan.newPixels.length > 0) {
    const body = plan.newPixels.map((i) => ({ index: i, data: plan.pixelsRaw[String(i)] }));
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pixels`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (res.status === 201 || res.status === 204) results.pixels.inserted = body.length;
    else results.pixels.errors.push(`HTTP ${res.status}`);
  }
  if (plan.newDocs.length > 0) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(plan.newDocs),
    });
    if (res.status === 201 || res.status === 204) results.documents.inserted = plan.newDocs.length;
    else results.documents.errors.push(`HTTP ${res.status}`);
  }
  if (plan.newSigs.length > 0) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/used_signatures`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(plan.newSigs.map((signature) => ({ signature }))),
    });
    if (res.status === 201 || res.status === 204) results.signatures.inserted = plan.newSigs.length;
    else results.signatures.errors.push(`HTTP ${res.status}`);
  }
  return results;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set in the environment — refusing to run blind.");
    process.exit(1);
  }
  console.log(`[import-dryrun] data dir: ${DATA_DIR}`);
  console.log(`[import-dryrun] target:   ${SUPABASE_URL}`);
  console.log(`[import-dryrun] mode:     ${APPLY ? "APPLY (writes!)" : "dry-run (no writes)"}`);

  const plan = await report();
  console.log("\n=== DRY RUN REPORT ===");
  console.log(JSON.stringify(plan.summary, null, 2));
  if (plan.malformed.length > 0) {
    console.log(`\nMALFORMED (${plan.malformed.length}, always skipped):`);
    for (const m of plan.malformed) console.log(`  - ${m}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — no writes made. Re-run with --apply to import (only after this report looks correct).");
    return;
  }
  if (plan.malformed.length > 0) {
    console.error("\nRefusing --apply: malformed entries found above. Fix the source data and re-run dry-run first.");
    process.exit(1);
  }
  console.log("\n=== APPLYING ===");
  const results = await apply(plan);
  console.log(JSON.stringify(results, null, 2));
  const anyErrors = [results.pixels, results.documents, results.signatures].some((r) => r.errors.length > 0);
  if (anyErrors) {
    console.error("\nOne or more imports reported errors — see above.");
    process.exit(1);
  }
  console.log("\nImport complete.");
}

main().catch((err) => {
  console.error(`[import-dryrun] fatal: ${err.message}`);
  process.exit(1);
});
