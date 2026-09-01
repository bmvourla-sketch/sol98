# SOL-98 — PHASE 1: PRODUCTION DATABASE + PERMANENT OWNERSHIP HARDENING

**Date:** 2026-08-31
**Status:** EXECUTED + VERIFIED against a real, empty Supabase staging project (ref `hjziuadsnlofgarjsawy`, region eu-central-1). No production project touched. No real user or real-money data was used at any point — every row this phase wrote was synthetic (`Phase1Test*` / `Drill*` wallets, index range 7,000,000+ / 8,000,000+, `phase1test-*` / `drill-*` ids), and every table this phase populated was cleaned back to zero rows before finishing.

This document supersedes the earlier DESIGN-ONLY draft (same filename, prior session) — that draft ended `FAIL (BLOCKED)` for lack of credentials. This phase had credentials for a fresh staging project and executed the full plan against it.

---

## 1. Architecture before

- Every server store branched: `if (isSupabaseConfigured()) → Supabase PostgREST; else → file data/*.json`, with `isSupabaseConfigured() = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)` and **no production/dev distinction** — missing credentials in production silently fell back to the ephemeral Vercel filesystem.
- `pixel-db.ts` had both backends (`pixel-db-supabase.ts` existed but was, per the README's own words, "code-ready but untested locally").
- **`board-db.ts` (Start Ads / board.exe) had NO Supabase backend at all** — file-only, unconditionally, even though board.exe sells for real SOL (2 SOL + 10%/sale, same mechanics as the main board). This was a real-money durability gap not previously documented, found during this phase's store inventory (before any code was written).
- `document-db.ts` and `used-signatures.ts` already had Supabase branches.
- Concurrency: in-process `mutex` (`lib/server/mutex.ts`) only — correct for a single Node process, meaningless across multiple Vercel serverless instances.
- No payment ledger and no ownership-history table existed anywhere.

## 2. Architecture after

- **`requireDurableStore()`** (`lib/server/supabase-env.ts`): called at the top of every WRITE function across `pixel-db.ts`, `board-db.ts`, `document-db.ts`, `used-signatures.ts`. When `NODE_ENV === "production"` and Supabase isn't configured, it **throws** — the error propagates through the route handler's existing `try/catch` into a plain `500` JSON response. There is no fallback branch after the throw; nothing downstream can reach the file store. Verified with real assertions in `tests/require-durable-store.test.ts` (see §12).
- Dev/test (`NODE_ENV !== "production"`) is a no-op — local dev and the existing 159-test suite keep using the file store exactly as before. Verified: same file-store test suite still 159/159 green with `requireDurableStore()` added.
- **`board-db-supabase.ts`** (new): closes the Start Ads gap, mirroring `pixel-db-supabase.ts`'s conditional-UPDATE pattern exactly, over two new tables (`board_files`, `board_pixels`).
- **`payment-ledger.ts`** (new) and **`ownership-history.ts`** (new): best-effort, server-only writers to `payment_transactions` / `pixel_ownership_history`, wired into every paid mutation in `app/api/pixels/route.ts`, `app/api/boards/route.ts`, `app/api/documents/route.ts`. "Best-effort" is deliberate — see §8; they are a second, additive safeguard, never a gate on the existing `used_signatures` check (red rule #6: don't change existing auth/payment logic).
- **`audit-log.ts`** (new): secret-free structured `console.log`/`console.error` for payment verification (success/failure), ownership mutation, ownership conflict, DB failure, duplicate transaction, authorization failure.
- No pricing, hijack-tier, rent, auth-message, or verify-tx/verify-message logic was touched. `git diff`-visible proof: `app/api/*/route.ts` changes are additive (new imports + logging/ledger calls immediately before/after existing verification and write calls) — no verification condition, price formula, or control-flow branch was altered.

## 3. Database schema (APPLIED to staging, verified via `list_tables`)

Three migrations, `supabase/migrations/000{1,2,3}_*.up.sql` (+ matching `.down.sql` rollbacks):

**0001_core_tables** — `pixels` (`index bigint` PK, `data jsonb`), `documents`, `used_signatures`. Matches the README-documented schema **with one fix**: `documents.id` was documented as `bigint generated always as identity`, which a real INSERT against staging rejected (`HTTP 400`) — the app generates and sends its own string id (`` `${Date.now()}-${random}` ``, see `lib/document-types.ts` `DocumentData.id: string`, sent by `app/api/documents/route.ts`). A `generated always as identity` column refuses any client-supplied value. Fixed to `id text primary key` in the migration file and re-applied to staging (`0001b_fix_documents_id_type`); verified by a subsequent successful insert (§9).

**0002_board_tables** — `board_files` (`id text` PK), `board_pixels` (`board_id text, index int` composite PK), plus a `data->>'owner'` index and a partial `bannerGroupId` index. Closes the Start Ads durability gap from §1.

**0003_ownership_integrity** —
```sql
create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  signature text not null unique,           -- idempotency
  wallet text not null,
  action text not null,                      -- buy / buy-area / hijack / buy-listing / rent / buy-board / buy-document
  amount_sol numeric,
  mint text,
  status text not null default 'verified',
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.pixel_ownership_history (
  id uuid primary key default gen_random_uuid(),
  pixel_index int not null,
  board_id text,                             -- null = main board
  prev_owner text,
  new_owner text not null,
  action text not null,
  signature text,
  created_at timestamptz not null default now()
);
```
Indexes: `idx_ownership_pixel(pixel_index, board_id, created_at)`, `idx_payments_wallet(wallet, created_at)`, `idx_payments_action(action, created_at)`.

All seven tables have RLS **enabled with no policies** — only the service-role key (server-only, bypasses RLS) can reach them, matching the app's existing security model (no client-side Supabase access anywhere). Confirmed via `get_advisors(type: security)`: seven `INFO`-level "RLS enabled, no policy" notices, all expected, zero actionable findings.

## 4. Migration (applied + tooling)

Applied via Supabase MCP `apply_migration` against `hjziuadsnlofgarjsawy`, in order, each returning `{"success":true}`; `list_tables` afterward confirmed all seven tables with the expected columns/PKs.

**`scripts/import-json-dryrun.mjs`** (new): reports before/after/duplicate/malformed/skipped counts for `pixels.json` → `pixels`, `documents.json` → `documents`, `used-signatures.json` → `used_signatures`. Never writes without `--apply`, and `--apply` refuses outright if any malformed entry was found. Run against this repo's real (empty) `data/` and the staging project: `0/0/0` across all three tables — confirmed no import risk exists from this environment. Separately exercised end-to-end against a synthetic fixture (`/tmp/dryrun-fixture`, outside the repo): dry-run correctly reported 2 new pixels / 1 new document / 2 new signatures with one deliberately malformed pixel entry listed and blocking `--apply`; after fixing the fixture, `--apply` inserted exactly those rows (the `documents.id` bug above was found and fixed during this exact run); a second dry-run then correctly reported all of them as duplicates (`wouldImport: 0`). All fixture rows were deleted afterward — staging left at zero rows. `boards.json` → `board_files`/`board_pixels` is **not yet covered** by this tool (noted in README "Bilinen sınırlar" — no legacy `boards.json` data exists anywhere to migrate yet, since the Supabase board backend is new this phase).

## 5. Environment safety

- `SUPABASE_SERVICE_ROLE_KEY` is read only inside `server-only`-guarded modules (`lib/server/supabase-env.ts` and everything that imports it) — unchanged from before this phase, re-verified.
- Nothing Supabase-related is `NEXT_PUBLIC_*`.
- **The staging project's credentials were never written to any file under version control.** They were used only as shell-exported environment variables for test runs in this session, and are written to the target machine's `.env.local` (gitignored, already excluded via `.env*` in `.gitignore`) as a follow-up delivery step outside the repo itself.
- `requireDurableStore()` is the enforcement point for "missing config must not cause silent fallback" (red rule #3) — see §12 for the real test evidence.

## 6. JSON fallback behavior

Production (`NODE_ENV=production`) + no Supabase config → every WRITE throws before touching the filesystem. Proven, not asserted: `tests/require-durable-store.test.ts` asserts `data/` is never created as a side effect of nine different write-path attempts (pixels create/update/hijack/group-update, boards create/update/hijack/rename, documents create, signature claim) under that condition. Dev/test mode is provably unaffected (same suite, one test: the identical write path still succeeds against the file store when `NODE_ENV !== "production"`).

## 7. Ownership consistency

- **One current owner per pixel**: enforced by Postgres — `pixels.index` / `board_pixels.(board_id,index)` are primary keys, so `createPixels`/`createBoard` on a taken spot gets a constraint conflict, never a silent overwrite (verified: "no re-selling a sold pixel" test, §12).
- **History consistent with current ownership**: verified with a real buy→hijack sequence against staging — the ownership_history rows come back in order (`buy`, `hijack`) with `prev_owner`/`new_owner` matching each transition, and the pixel's actual live owner equals the last history row's `new_owner` (§12).
- **No ownership without payment verification**: structural, unchanged from before this phase — `app/api/pixels/route.ts` / `app/api/boards/route.ts` call `verifySolTransfer`/`verifyTokenTransfer`/`verifyBurn` and `claimSignature` BEFORE any DB write, for every paid action; this phase only added logging/ledger calls after those existing checks, never before or in place of them.
- **Rent is deliberately excluded from `pixel_ownership_history`**: rent changes `rentedTo`/`rentedUntil`, not `owner` — logging it there would violate the "history matches current owner" invariant. It is still recorded in `payment_transactions` (real payment, no ownership change).

## 8. Concurrency strategy — verified against a real database, not a JS mutex

`pixel-db-supabase.ts` and the new `board-db-supabase.ts` use PostgREST's row-filtered `PATCH …?index=eq.N&data->>owner=eq.PREV_OWNER` — Postgres evaluates that `WHERE` against the live row at UPDATE time, so two concurrent requests racing the same row can't both win. **No process-local mutex is involved on this path** — `withLock()` (`mutex.ts`) is only used by the file-store branch.

Proven with real concurrent HTTP calls against the live staging database (`tests/integration/phase1-staging.test.ts`, run with `NODE_ENV=production` + real staging creds, `Promise.all` racing the SAME row, not simulated):
- Two `createPixels` calls racing one brand-new index → exactly one `ok:true`, one `ok:false` (taken), stored row matches exactly one of the two racing owners.
- Two `hijackPixel` calls racing one existing pixel → at least one wins, final stored owner is exactly one of the two contenders, never a corrupted merge.
- The same two races repeated for `board-db-supabase.ts` (`createBoard`, `hijackBoardPixel`) — same guarantee, newly extended to Start Ads this phase.
- An 8-way concurrent hijack race (`multi-instance-simulation`) on one pixel — every one of the 8 calls is an independent read-then-conditional-write with zero shared in-process state, the closest a single test process can get to genuinely separate serverless instances — final owner is exactly one of the 8 contenders.

## 9. Idempotency strategy

Two independent layers, deliberately not merged (red rule #6 — `used_signatures` was not touched):
1. **`used_signatures`** (unchanged, pre-existing): `signature` PK — a replayed signature is rejected before any DB write is attempted. Verified again this phase (`#7 duplicate-purchase`, `#13 rollback`): claim → true, re-claim → false, release → re-claimable.
2. **`payment_transactions.signature UNIQUE`** (new, additive): a second insert of the same signature gets `HTTP 409` from Postgres directly — verified with two real inserts against staging.

`recordPaymentTransaction`/`recordOwnershipHistory` are deliberately **best-effort** (log-and-continue on failure, via `audit-log.ts`'s `db_failure` event) — a customer who already passed `verifySolTransfer` and claimed their `used_signatures` row must not lose their already-legitimate purchase because a telemetry insert failed. This is a considered tradeoff, not an oversight: the two DB-level idempotency layers above (`used_signatures`, `payment_transactions` unique constraint) are what actually prevent double-spend; the ledger/history tables are audit trail on top of that, not a gate.

## 10. Backup / recovery — executed, not just designed

Full drill run against staging (never production, red rule #10):
1. **CREATE**: two synthetic pixels, one document, two ownership-history rows.
2. **BACKUP**: a `jsonb_build_object` logical export of exactly those rows (application-level equivalent of `pg_dump` for this purpose), saved to a local JSON file.
3. **DELETE**: all drill rows removed — re-verified `0` rows remaining.
4. **RESTORE**: re-inserted verbatim from the saved backup JSON (same ids, same `created_at` timestamps).
5. **VERIFY**: re-read confirmed both pixels' owners, the document's owner, and both history rows exactly match the pre-delete state.

Production backup posture (documented, standard Supabase capability — not re-invented here): daily PITR + `pg_dump` export; restore = new project or PITR rollback + re-point `SUPABASE_URL`/keys in Vercel env. This phase proves the *application data* survives a delete/restore cycle intact — it does not stand up a second Supabase project to test PITR/`pg_dump` itself, since that's Supabase-managed infrastructure, not this app's code.

## 11. Test results

```
npm run typecheck   → clean (tsc --noEmit, 0 errors)
npm run lint        → ✔ No ESLint warnings or errors
npm test             → 18 files, 163/163 passed  (was 17 files / 159 — 4 new
                        fail-closed tests added to the existing file-store suite;
                        every pre-existing test still passes unmodified)
npm run build        → ✓ Compiled successfully, all 3 API routes + static pages generated
```

**`tests/require-durable-store.test.ts`** (part of `npm test`, no network) — 4 tests:
missing-credentials throws · DB-unavailable-in-production throws before any file write · every one of 9 write paths (pixels/boards/documents/signatures) fails closed with zero JSON side effects · dev/test mode unaffected.

**`tests/integration/phase1-staging.test.ts`** (real staging DB, run explicitly via `npm run test:integration` with staging credentials — excluded from default `npm test` so CI/local stays offline) — **15/15 passed**, against the live project:
DB available · purchase · duplicate-purchase (signature replay rejected) · concurrent-purchase (two different pixels) · same-pixel-concurrent-purchase (createPixels race, exactly one winner) · same-pixel-concurrent-hijack (conditional-UPDATE race) · ownership-update · ownership-history (single write, read back matches) · no-re-selling-a-sold-pixel · history-consistent-with-live-ownership (buy→hijack sequence) · duplicate-transaction (`payment_transactions` UNIQUE, `409`) · rollback (`releaseSignature`) · server-restart-simulation (fresh module graph reads state written before "restart") · multi-instance-simulation (8-way concurrent hijack race) · board-db-supabase round-trip + race (Start Ads).

Migration dry-run tool: exercised live against staging with both an empty (real) dataset and a synthetic fixture, including a deliberate malformed-entry rejection and a real duplicate-detection re-run (§4).

Backup/restore drill: executed live against staging, full CREATE→BACKUP→DELETE→RESTORE→VERIFY cycle (§10).

All test/drill data was synthetic and was deleted after each run — staging project confirmed at 0 rows across all 7 tables at the end of this phase.

## 12. Remaining risks

1. **`scripts/import-json-dryrun.mjs` doesn't cover `boards.json` yet** — not a current risk (no legacy `boards.json` data exists to migrate, since the board Supabase backend is new this phase), but should be extended before any deploy that has real Start Ads file-store data to migrate.
2. **Rate limiting (`lib/server/rate-limit.ts`) is still in-process/in-memory**, unchanged by this phase — resets on cold start, doesn't span multiple serverless instances. This is a availability/abuse concern, not an ownership-correctness one (ownership atomicity no longer depends on it at all, see §8) — already flagged in the README's "Bilinen sınırlar," now explicitly decoupled from the ownership-safety claim.
3. **`payment_transactions`/`pixel_ownership_history` writes are best-effort** (§9) — by design, but means a Supabase hiccup immediately after a successful, already-committed ownership change could leave that one event unaudited (never unpersisted-but-charged — the ownership write itself already succeeded). Logged as `db_failure` via `audit-log.ts` either way.
4. **Two concurrent real on-chain hijack/buy attempts on the same spot**: the losing side's payment/burn has already landed on-chain before the DB race is even decided (pre-existing, documented limitation, unrelated to this phase — full atomicity would need an on-chain escrow program).
5. Production Vercel env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) still need to be set in Vercel itself before any real deploy — this phase stops at proving the code+schema+staging-DB combination works; it does not deploy (explicitly out of scope this phase).

## 13. Phase 2 readiness: YES, for the database layer

Ownership/payment durability, atomicity, and idempotency are now proven against a real database, not designed-on-paper. Phase 2 concerns (per the Phase 0 audit's BLOCKER #2 and #3 — the on-chain-ownership documentation claim, and free/zero-cost hijack before token launch) are unrelated to this phase and remain open.

---

**PHASE 1 STATUS: PASS**
