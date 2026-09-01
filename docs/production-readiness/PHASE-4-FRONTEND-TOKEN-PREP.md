# SOL-98 — Phase 4: Frontend Intent Integration, Treasury Atomicity & Token Prep

**Status:** COMPLETE — all three GÖREVs implemented, tested (unit + real-staging integration), and verified. Nothing committed or pushed (see §12).

## Context this phase started from

Phase 3 closed finding **P2-F1** (transaction substitution) by making `buy-listing` / `rent` / `hijack` (live) require a server-issued `purchase_intents` record, and closed part of **P2-F4** (ledger completeness) for those same three UPDATE-based handlers via the `update_pixel_owner_atomic` / `update_board_pixel_owner_atomic` RPCs. That left two things broken/incomplete on purpose, both scoped into this phase:

1. **The frontend never learned about `intentId`.** `lib/pixel-store.tsx` and `lib/board-store.tsx` still POSTed a bare `index` for buy-listing/rent/hijack — every one of those three flows was broken in the running app from the moment Phase 3 shipped, until this phase's GÖREV 1.
2. **The treasury purchase paths (`buy` / `buy-area` / `buy-board`) were explicitly left non-atomic** — see `PHASE-3-MARKET-SECURITY.md` §4.4's disclosed scope boundary. GÖREV 2 closes that.

GÖREV 3 ties the (still pre-launch) `$PIXEL98` hijack UI to this now-real intent system, so the code is launch-ready without requiring another pass once the token mints.

---

## GÖREV 1 — Frontend Intent Integration

### Required flow, as implemented

1. User clicks Buy/Rent/Hijack in the UI.
2. **Before** the wallet is asked to sign anything, the client calls `POST /api/purchase-intents` (`lib/purchase-intent.ts`'s `createPurchaseIntent()`) with `{ actor, actionType, boardId, index, days? }`.
3. The server re-reads the **live** listing/rent/hijack state itself (unchanged from Phase 3) and returns `{ intentId, expiresAt, currency, price, sellerWallet, ... }` — all of it server-authoritative, none of it trusted from anything the client sent beyond *which* spot.
4. The client builds the payment transaction from **the server's response**, not from its own (possibly stale, `POLL_MS`-old) local board cache: `sendTransfer(intent.priceSol, new PublicKey(intent.sellerWallet))` for buy-listing/rent; `hijackBurn({ owner: intent.sellerWallet, burnTokens: intent.burnedTokensPreview, transferTokens: intent.ownerTokensPreview })` for hijack.
5. Once the wallet returns a signature, the client redeems by POSTing `{ action, actor, intentId, signature }` to `/api/pixels` or `/api/boards` — **`index` is never sent again**.
6. Errors (410 expired / 403 foreign wallet / 409 conflict) are caught and mapped to a message the user can act on.

### New/changed files

- **`lib/purchase-intent.ts`** (new) — the client-side counterpart to `app/api/purchase-intents/route.ts`. Exports:
  - `ApiError` — an `Error` subclass carrying the HTTP status, so callers can branch on 410/403/409/etc. instead of parsing message text.
  - `postJson<T>(url, body)` — the single shared "POST JSON, throw `ApiError` on non-2xx" implementation. **Both** `createPurchaseIntent()` in this file **and** the redemption-call `postAction()` in `lib/pixel-store.tsx` / `lib/board-store.tsx` now go through this one function — see "own-initiative decisions" below for why this refactor was made.
  - `createPurchaseIntent(params)` — builds the exact request shape `POST /api/purchase-intents` expects and maps its response into a typed `IntentResult` (including the new `sellerWallet` field — see below).
  - `friendlyIntentError(err)` — maps `ApiError` status codes to a plain-language message (410 → "expired…", 403 → "doesn't match your connected wallet…", 409 → "changed right before your payment landed…", 404 → "isn't available anymore", 503 → passes the server's own message through unchanged since it's already user-facing). Falls back to `err.message` for anything else, and a generic string for a non-`Error` throw.
  - `msUntil(expiresAt)` / `formatCountdown(expiresAt)` — small pure helpers for the countdown UX.
- **`components/intent-countdown.tsx`** (new) — a small live-ticking `<IntentCountdown expiresAt={…}>` component: "Complete this transaction within **14:32** or it will expire," turning red under 60s, or "This offer just expired — please try again" once it hits zero. This is the "İşlemi tamamlamak için 15 dakikanız var" UX the brief asked for.
- **`lib/pixel-store.tsx`** (modified):
  - `TxPhase` gained a `"creating_intent"` value (was `"awaiting_signature" | "processing" | null`).
  - New `ActiveIntent` type + `activeIntent` state/context field, so dialogs can render the countdown while a reservation is live.
  - `hijackPixel` (live-burn branch only — the pre-launch simulated branch is untouched, since nothing is paid there), `buyListing`, and `rentPixel` all now: create an intent first, use the intent's `sellerWallet`/`priceSol` (or `burnedTokensPreview`/`ownerTokensPreview` for hijack) to build the payment, then redeem with `intentId`.
- **`lib/board-store.tsx`** (modified) — the identical mirror for board.exe sub-blocks, **plus** it now exposes `txPhase`, `activeIntent`, `hijackCostTokens`, and `hijackSplit` on `BoardContextValue`, none of which existed on that context before this phase (see own-initiative decisions).
- **`components/pixel-dialog.tsx`**, **`components/market.tsx`**, **`components/start-ads.tsx`** (modified) — wired `friendlyIntentError` into every catch block that can now surface an intent-related status, added `<IntentCountdown>` where a reservation is active, and updated busy-button labels to distinguish "Locking price…" (creating the intent) from "Confirm in wallet…" (awaiting signature) from "Paying…"/"Burning…" (processing).

### Own-initiative decisions in GÖREV 1 (disclosed)

1. **Added `sellerWallet` to `POST /api/purchase-intents`'s response** (all three action types). The brief didn't ask for this explicitly, but without it the client had no server-authoritative recipient address for the peer-to-peer payment — it would have had to keep using its own local `pixels[index].owner`/`pixels[`${boardId}:${index}`].owner`, which is exactly the kind of "could be `POLL_MS` stale" value Phase 2/3 already established the server should never trust. This is a **correctness** fix, not a **security** one: `handleBuyListing`/`handleRent`/`handleHijack` already re-verify the payment against `intent.sellerWallet` server-side regardless of what the client actually sent it to, so a client that ignored this field and used its stale cache would just fail with a clean 402/409, never a wrong-recipient exploit.
2. **Refactored `postAction()` (in both stores) to share `lib/purchase-intent.ts`'s `postJson()`** instead of duplicating the same fetch/error-wrapping logic three times (once in each store, once inline in the original `createPurchaseIntent` draft). This is what makes `tests/integration/phase4-frontend-intent-staging.test.ts` a genuine test of the code the UI runs, not a re-implementation of it — see §5.
3. **Exposed `txPhase` / `activeIntent` / `hijackCostTokens` / `hijackSplit` on `BoardContextValue`.** `lib/board-store.tsx` tracked `txPhase` as private local state before this phase (never on the context) and had no hijack-cost-preview fields at all (unlike `lib/pixel-store.tsx`, which already exposed `hijackCostFor`/`hijackCostTokens`/`hijackSplit` for the main board). This asymmetry meant `components/start-ads.tsx`'s hijack button showed no cost estimate at all pre-click. Fixed as part of GÖREV 3 below, disclosed here because it's a `BoardContextValue` shape change.

---

## GÖREV 2 — Treasury Purchase Atomicity (INSERT RPCs)

### The gap

`handleBuy` / `handleBuyArea` (`app/api/pixels/route.ts`) and `handleBuyBoard` (`app/api/boards/route.ts`) ran `createPixels()`/`createBoard()` (a plain PostgREST `INSERT`) followed by two **separate, best-effort** writes: `recordPaymentTransaction()` and `recordOwnershipHistory[Batch]()` — both of which are deliberately non-throwing by design (see their own header comments: a failed telemetry write must never roll back an already-successful, already-paid-for purchase). That's correct behavior for pure telemetry, but it means ownership could change hands with **zero** corresponding ledger/history row if either of those best-effort writes failed for a real reason — the exact P2-F4 risk Phase 3 closed for the P2P paths and explicitly left open here.

`board-db-supabase.ts`'s `createBoard()` had an additional, independent gap of its own: it inserted the `board_files` row and the 100 `board_pixels` sub-block rows as **two separate PostgREST calls** (PostgREST has no multi-statement transaction endpoint), with a manual best-effort compensating `DELETE` of the file row if the second insert failed — a real "half-created board.exe" window under a genuine DB error between the two.

### The fix — two new Postgres RPCs

**`supabase/migrations/0005_treasury_purchase_atomicity.up.sql`** adds:

- **`insert_pixels_atomic(p_records, p_signature, p_wallet, p_action, p_amount_sol, p_mint)`** — one `plpgsql` function, one Postgres transaction, covering: the pixel row `INSERT`, the `payment_transactions` `INSERT`, and the `pixel_ownership_history` `INSERT`(s).
- **`insert_board_pixels_atomic(p_file_id, p_file_data, p_records, p_signature, p_wallet, p_action, p_amount_sol, p_mint)`** — same shape, additionally covering the `board_files` row `INSERT` and the `board_pixels` sub-block `INSERT`s in the same transaction, closing the two-INSERT non-atomicity described above.

**Two different failure modes, handled two different ways, deliberately:**

- An **expected** race — someone else bought one of the same spots microseconds earlier — hits `pixels.index`'s primary key. This is wrapped in its own `begin … exception when unique_violation … end` block, which PL/pgSQL implements as an implicit `SAVEPOINT`: it rolls back **only** that `INSERT` attempt and returns a clean `(ok=false, reason='conflict', taken=[...])` row, preserving `createPixels()`'s exact original caller contract (`app/api/pixels/route.ts`'s 409 handling for `handleBuy`/`handleBuyArea` needed **zero** changes).
- A **genuine anomaly** at the ledger step — `payment_transactions`' own `UNIQUE(signature)` firing, which should only ever happen if `used_signatures.claimSignature()` upstream somehow let a duplicate through, or in the adversarial test below — is **not** wrapped in an exception handler. It's left to propagate as a normal Postgres error out of the function, which rolls back **everything** already executed in that same call, including the pixel/board rows just inserted. This is proven directly (RPC called by hand, not through the route) in the RED TEAM tests below.

Both functions are written `set search_path = ''` with every table reference aliased and fully qualified (`public.pixels as pix`, `public.board_pixels as bp`, …) **from the start** — this is a direct lesson carried over from Phase 3's `0004` → `0004c` debugging history (a bare `data`/`index` identifier colliding with a PL/pgSQL variable PL/pgSQL auto-declares from a function's own `returns table(...)` clause). Applying this migration to staging produced **zero** new advisor findings (see §6) — the search-path fix didn't need a follow-up `0005b` this time.

### New server modules

- **`lib/server/pixel-insert-atomic.ts`** — `insertPixelsAtomic(params)`. Supabase path calls the RPC; file-store (dev-only) path falls back to `createPixels()` + the same best-effort writes as before, explicitly documented as non-atomic in dev (same pattern Phase 3 established for `pixel-mutations-atomic.ts`).
- **`lib/server/board-insert-atomic.ts`** — `insertBoardAtomic(params)`, the board.exe mirror.

### Route changes

`app/api/pixels/route.ts`'s `handleBuy`/`handleBuyArea` and `app/api/boards/route.ts`'s `handleBuyBoard` now call `insertPixelsAtomic`/`insertBoardAtomic` instead of `createPixels`/`createBoard` + two separate ledger calls. The Phase 2.1 thrown-error → `releaseSignatureSafely` → rethrow pattern, and the clean-conflict → `releaseSignatureSafely` → 409 pattern, are both preserved unchanged — only the "what happens after payment verification passes" internals changed. `recordPaymentTransaction`/`recordOwnershipHistory[Batch]` imports were removed from both route files where they became unused (`recordOwnershipHistory` — the singular form — is still imported and used by the pre-launch simulated-hijack paths in both files, which are unaffected by this phase).

### Explicit scope boundary (same discipline as Phase 3 §4.4)

`buy-listing` / `rent` / `hijack` (live) are **not** touched by this GÖREV — they already went through `update_*_owner_atomic` in Phase 3. This GÖREV is exclusively about the three INSERT-based treasury paths named in the brief.

---

## GÖREV 3 — `$PIXEL98` & Hijack UI/UX

Two sub-requirements, both about the **live-burn** hijack path (the pre-launch simulated path is free and unaffected by any of this):

1. **"Frontend'de doğru dinamik fiyatı (burnedFraction üzerinden hesaplanan) gösterdiğinden emin ol."** `components/pixel-dialog.tsx` already showed a pre-click estimate (`hijackCostFor(index)`, derived from the polled `burnedFraction`) before this phase. `components/start-ads.tsx`'s board sub-block hijack button showed **no cost estimate at all** — `lib/board-store.tsx` never exposed `hijackCostTokens`/`hijackSplit` on its context (see GÖREV 1's own-initiative decision #3). Fixed: `BoardContextValue` now exposes both, and `SubBlockDialog` renders "Est. cost: N $PIXEL98 (X burned · Y to owner)" the same way the main board's dialog does.
2. **"Intent oluşturulurken Hijack maliyeti kilitlenmiyordu (Phase 3 kararı). UI, cüzdan onayı sırasında güncel maliyeti doğru yansıtmalı."** Confirmed and implemented: the pre-click estimate above is necessarily a few seconds to `POLL_MS` (20s) stale — it's only for display. The **actual** amounts sent to the wallet for signing (`hijackBurn({ burnTokens, transferTokens })`) now come from the purchase intent's own `burnedTokensPreview`/`ownerTokensPreview`, which `POST /api/purchase-intents` computes **fresh, at intent-creation time**, from the live `getBurnedFraction()` — i.e. strictly closer to redemption time than the polled board-wide value. The redemption route (`handleHijack`, unchanged since Phase 3) then recomputes the cost **again**, fresh, at verification time — the intent's preview is never trusted as the actual charged amount, only used to build the transaction the wallet is asked to sign. This preserves Phase 3's "hijack never locks in a price" decision end to end: display estimate (stale, cosmetic) → intent preview (fresh at request time, used to build the tx) → server re-verification (fresh at redemption time, authoritative).

No backend changes were needed for GÖREV 3 beyond what GÖREV 1 already did (routing hijack through the intent system) — this GÖREV was entirely about making the frontend consume the already-correct backend values instead of a stale local computation.

---

## Files changed

**New:**
- `supabase/migrations/0005_treasury_purchase_atomicity.up.sql`
- `supabase/migrations/0005_treasury_purchase_atomicity.down.sql`
- `lib/server/pixel-insert-atomic.ts`
- `lib/server/board-insert-atomic.ts`
- `lib/purchase-intent.ts`
- `components/intent-countdown.tsx`
- `tests/phase4-purchase-intent-client.test.ts`
- `tests/integration/phase4-treasury-atomicity-staging.test.ts`
- `tests/integration/phase4-frontend-intent-staging.test.ts`
- `docs/production-readiness/PHASE-4-FRONTEND-TOKEN-PREP.md` (this file)

**Modified:**
- `app/api/pixels/route.ts` — `handleBuy`/`handleBuyArea` → `insertPixelsAtomic`; import cleanup.
- `app/api/boards/route.ts` — `handleBuyBoard` → `insertBoardAtomic`; import cleanup.
- `app/api/purchase-intents/route.ts` — added `sellerWallet` to all three response branches.
- `lib/pixel-store.tsx` — intent integration in `hijackPixel`/`buyListing`/`rentPixel`; `ActiveIntent`/`TxPhase` additions; `postAction` now calls shared `postJson`.
- `lib/board-store.tsx` — same mirror, plus newly-exposed `txPhase`/`activeIntent`/`hijackCostTokens`/`hijackSplit`.
- `components/pixel-dialog.tsx` — hijack error mapping, countdown, `creating_intent` phase label.
- `components/market.tsx` — buy-listing/rent error mapping, countdown, busy label.
- `components/start-ads.tsx` — buy-listing/rent/hijack error mapping, countdown, hijack cost display, busy labels.

---

## Test results

### Unit suite (`npx vitest run`, no network, no live DB)

```
Test Files  22 passed (22)
     Tests  216 passed (216)
```

204 pre-existing tests (all still pass, unmodified assertions — confirming `handleBuy`/`handleBuyArea`/`handleBuyBoard`'s externally-visible behavior is unchanged by the GÖREV 2 refactor) + **12 new** in `tests/phase4-purchase-intent-client.test.ts`, covering `lib/purchase-intent.ts` against a mocked `fetch`: request-shape assertions for buy-listing/rent/hijack intent creation, response-field mapping (including that hijack's preview fields are never treated as a locked-in price), `ApiError` status/message propagation through `postJson`, and `friendlyIntentError`'s mapping for every status the checklist below cares about (410/403/409/404/503) plus its fallback behavior.

### `tsc --noEmit`, `next lint`, `next build`

All three clean. `next build`'s route table confirms `/api/purchase-intents` (added in Phase 3) is still correctly registered as a dynamic route, and the build produces no new warnings.

### Staging integration suite (real Supabase project `hjziuadsnlofgarjsawy`, never production)

Run explicitly (service-role key passed as a shell-exported env var only, never written to any file — see §12):

```
SUPABASE_URL=https://hjziuadsnlofgarjsawy.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<exported, not written to disk> \
NODE_ENV=production \
  npx vitest run --config vitest.integration.config.mts
```

```
Test Files  5 passed (5)
     Tests  34 passed (34)
```

26 pre-existing (Phase 1 + Phase 2 + Phase 3's 4 red-team items) + **8 new**, split across the two new files:

**`tests/integration/phase4-treasury-atomicity-staging.test.ts`** (GÖREV 2, 5 tests):
- `buy-area`: one HTTP call → both pixel rows owned by the buyer, exactly one `payment_transactions` row, exactly two `pixel_ownership_history` rows — all verified via direct PostgREST reads against real Postgres, not the response body. **This is the literal Phase 4 checklist item**: *"UI üzerinden Hazine alımı (buy-area) ve DB'de ownership + ledger'ın aynı anda hatasız oluşması."*
- `buy`: a genuine already-taken conflict is reported cleanly as 409 (not a 500/exception), with the original owner confirmed untouched in real Postgres.
- **RED TEAM** — `insert_pixels_atomic`: a pre-inserted duplicate `payment_transactions.signature` row (called directly via the RPC, bypassing the route, same technique as Phase 3's RED TEAM #4) makes the RPC call fail; the pixel row that was inserted **earlier in that same function call** is confirmed **absent** afterward (rolled back), no ownership-history row exists, and there is still exactly one `payment_transactions` row (the pre-existing one, not a duplicate).
- **RED TEAM** — `insert_board_pixels_atomic`: identical proof, additionally confirming the `board_files` row is rolled back together with the `board_pixels` sub-block rows.
- `buy-board`: one HTTP call → the file row, all 100 sub-block rows, the ledger row, and all 100 history rows land together, verified directly.

**`tests/integration/phase4-frontend-intent-staging.test.ts`** (GÖREV 1, 3 tests) — see the note below on methodology:
- **Buy-listing happy path**: `lib/purchase-intent.ts`'s real `createPurchaseIntent()` → (payment verification mocked, same as every other route test in this repo) → the real `postJson()` redeeming with `intentId` → real Postgres confirms the pixel's owner changed. **This is the literal checklist item**: *"UI üzerinden başarılı bir 'buy-listing' akışı (Intent oluşturma -> İmza -> Başarılı API çağrısı)."*
- **Expired intent**: a real intent is created, then its `expires_at` is rolled backward **directly in the database** via a PostgREST `PATCH` (not just in-process) — the literal instruction: *"Kasıtlı olarak intent'i expire edip (DB'den süreyi geriye alarak)."* Redemption through the real `postJson()` returns a 410 `ApiError`; `friendlyIntentError()` (the same function every dialog's catch block calls) is asserted to produce a human-readable, non-technical message. Real Postgres confirms ownership never changed.
- **Foreign wallet's intent**: an intent created by one wallet, redeemed by another → 403, mapped to a wallet-mismatch message.

**Methodology note on "UI üzerinden" (GÖREV 1's tests):** this repository has no browser/component test tooling (no Playwright, no React Testing Library — every existing test in `tests/` exercises API route handlers directly, none renders a component). Rather than skip the requirement or hand-roll a parallel implementation of the client's request/response logic (which would test a copy, not the real code), `tests/integration/phase4-frontend-intent-staging.test.ts` stubs `global.fetch` to forward `/api/...` calls directly into the real Next.js route handlers (which run for real against real staging Postgres) while passing every other URL through to the real network `fetch` unmodified — and then calls `lib/purchase-intent.ts`'s actual exported `createPurchaseIntent()`/`postJson()`/`ApiError`/`friendlyIntentError`, the exact same functions `lib/pixel-store.tsx` and `lib/board-store.tsx` call from inside their React hooks. This is disclosed as a deliberate, pragmatic substitute for a real browser click-through, not a silent gap — the brief's own wording ("...veya tam entegrasyon testi yazarak") explicitly allows a full integration test in place of a literal UI-driven one.

---

## Security advisor re-check

`mcp__Supabase__get_advisors(type: "security")` immediately after applying `0005`: only the same pre-existing `INFO`-level `rls_enabled_no_policy` findings present on every other server-only table in this project (expected — every table here is written exclusively through the service-role key, RLS enabled with no policies, no anon/publishable access anywhere). **Zero** new findings — unlike Phase 3's `0004`, this migration's functions shipped with `set search_path = ''` from the start, so no `0005b` follow-up was needed.

---

## Out of scope / explicitly not done this phase

- **On-chain ownership / smart contracts** — still explicitly out of scope per the standing constraint carried through every phase of this project ("Şu an Smart Contract'a GEÇMİYORUZ").
- **A literal browser-driven (Playwright/Cypress) end-to-end test** — see the methodology note above; no such tooling exists in this repo, and introducing an entire new test framework was judged out of proportion to a three-GÖREV phase brief that didn't ask for one.
- **`$PIXEL98` mainnet mint / Pump.fun launch itself** — this phase prepares the code path (GÖREV 3) but does not set `NEXT_PUBLIC_PIXEL98_MINT`; that remains an operational/deployment step, not a code change.
- **Extending intent-based atomicity to `buy`/`buy-area`/`buy-board`** — deliberately not needed; those got **INSERT**-based atomicity (GÖREV 2) instead, since they have no transaction-substitution exposure to begin with (uniform bonding-curve pricing, no peer-to-peer payment target to substitute).

---

## Definition of Done

- [x] Frontend creates a purchase intent before requesting a wallet signature, for buy-listing / rent / hijack(live).
- [x] UI surfaces the intent's expiry (`IntentCountdown`).
- [x] Redemption sends `intentId`, never `index`, to `/api/pixels` / `/api/boards`.
- [x] 410 / 403 / 409 (and 404 / 503) are caught and mapped to a user-facing message.
- [x] `insert_pixels_atomic` / `insert_board_pixels_atomic` RPCs created, applied to staging, zero new advisor findings.
- [x] `handleBuy` / `handleBuyArea` / `handleBuyBoard` use the new atomic RPCs.
- [x] Hijack UI shows a dynamic, `burnedFraction`-derived cost estimate (both the main board and board.exe sub-blocks).
- [x] Hijack's wallet-signing amount reflects the fresh, per-intent preview, not a stale poll value.
- [x] All required red-team/checklist scenarios coded **and run against real staging Postgres**.
- [x] `tsc --noEmit`, `next lint`, `next build`, full unit suite, full staging integration suite all green.
- [x] Nothing committed or pushed.

## Final status

- **GÖREV 1 (Frontend Intent Integration): DONE.** All three previously-broken flows (buy-listing/rent/hijack-live) work end to end again, now correctly, with proper 410/403/409 handling and expiry UX.
- **GÖREV 2 (Treasury Atomicity): DONE.** `buy`/`buy-area`/`buy-board` are now as atomic as the P2P paths were made in Phase 3 — proven by a real rollback under a real Postgres constraint violation, not just by code review.
- **GÖREV 3 (Token/Hijack UI Prep): DONE.** Hijack UI is launch-ready for `$PIXEL98` — dynamic pricing displayed and correctly sourced at every stage, no code changes anticipated when the token actually mints.

## Working tree / commit status

Per the standing instruction, repeated verbatim every phase: **"Her zamanki gibi kodu commit/push yapma, working tree'de bırak"** — nothing in this phase was committed or pushed; every new/modified file listed above is left in the working tree as-is (this cloud workspace has no `.git` directory at all, consistent with every prior phase).

**Secret handling:** the staging project's service-role key was used only as a shell-exported environment variable for the two `npx vitest run --config vitest.integration.config.mts` invocations in §5, and for the `mcp__Supabase__apply_migration`/`get_advisors` tool calls (which take the project ref, not the key, as their credential). It was never written into any file created or modified this phase. Verified via a repository-wide grep for the literal key value immediately before writing this report — the only match is the pre-existing `.env.local` (not touched, not created, not delivered this phase).
