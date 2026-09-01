# SOL-98 — PHASE 3: MARKET SECURITY, PURCHASE INTENTS & TOKEN PREP

**Date:** 2026-08-31
**Scope:** GÖREV 1 (Purchase Intent system, closes P2-F1), GÖREV 2 (wire the future live-hijack burn into the same intent system), GÖREV 3 (atomic ownership+ledger writes via a Postgres RPC, closes P2-F4). Explicit constraint honored: **no move to on-chain/smart-contract ownership** — the existing hybrid (off-chain DB + on-chain payment verification) model is hardened, not replaced. Working tree left uncommitted, nothing pushed (see §12).

This report opens, as instructed, by confirming finding **P2-F1** was read first:

> **P2-F1 (MEDIUM) — peer-to-peer payments are bound to `(buyer, seller, amount)`, not to a specific pixel.** `verifySolTransfer`/`verifyTokenTransfer` only ever confirm that a transfer of at least the required amount happened between two wallets. If the same seller has two listings at an identical price, a payment meant for listing A also satisfies the check the server runs for listing B — the buyer can submit the API request for B and keep A's payment. (docs/production-readiness/PHASE-2-PAYMENT-SECURITY.md)

Everything below is the fix for that finding, generalized into a reusable system per GÖREV 1's "system-wide central mechanism" phrasing, plus GÖREV 3's independent ledger-atomicity fix.

---

## 1. Architecture decision: server-side nonce vs. on-chain memo

GÖREV 1 explicitly delegated this choice. Two options were considered:

**Option A — on-chain `spl-memo`.** The client would attach an `spl-memo` instruction containing an intent id (or a canonical `pixel_index:price:seller` string) to the same transaction that pays the seller. The server would decode the memo instruction while verifying the transaction and cross-check it against the redemption request.

**Option B — server-side reservation (`purchase_intents` table), chosen.** The server issues an opaque `intent_id` *before* any payment happens, binding `(action_type, board_id, pixel_index, buyer_wallet, seller_wallet, price, currency, expires_at)` server-side. The client references that id at redemption; the server derives every economically meaningful value from the stored row, never from the request.

**Why B, not A:**

- **A does not actually close the gap on its own.** The memo only proves what the *client* claims it paid for — it is still just data in the transaction the client constructed. The server would have to independently decide whether to trust an unsigned, arbitrary string instruction over anything else it already reads from the transaction; nothing about a memo is more authoritative than the `index` field already sitting unbound in the request body today. A memo only *becomes* trustworthy if it round-trips through a server-issued value that the server can look up and validate — at which point the interesting part of the design is the server-issued value, not the memo mechanism carrying it. Option B does exactly that lookup, minus the on-chain plumbing.
- **A has real integration cost for no security gain.** Every client-side transaction-building code path (buy-listing, rent, hijack) would need `@solana/spl-memo`'s program id added to the transaction, the wallet adapter would need to show/sign one more instruction, and `verify-tx.ts` would need a new decode path (`isParsedInstruction` handling for the memo program) — a strictly bigger diff, touching Solana verification rules that are explicitly out of scope for this kind of change per the project's established Red Rules.
- **A cannot express "no locked-in price" cleanly.** GÖREV 2 requires that hijack's cost is *not* frozen at intent-creation time (it depends on the continuously-moving global burned fraction — see §3). A memo is fixed the instant the transaction is signed and sent; a server-side row can be created with a null/absent price field and have the real cost recomputed fresh at redemption, which is exactly what was needed.
- **A server-side nonce is a strictly stronger, simpler primitive.** It is wallet-bound (`buyer_wallet` must equal the redeeming actor — checked in Postgres/the route, not parsed from an on-chain instruction), time-bound (`expires_at`, checked against the database's own clock inside the same transaction that consumes it — see §4), and atomically single-use (`UPDATE ... WHERE status='pending' AND expires_at>now()`, inside the same Postgres function call that mutates ownership). None of those three properties come for free from a memo.
- **Partial server-signing** (the other option GÖREV 1 raised) was also considered and rejected for a much simpler reason: this app has no server-held signing key for user funds at all today (the treasury is a public address, not a keypair the API holds), and introducing one is a materially larger, riskier change than a new DB table — exactly the kind of "large subsystem unless necessary" the project's established conventions (see PHASE-2.1-P2-F2-FIX.md) warn against.

**Result:** `purchase_intents` (server-side reservation) was implemented. See §4 for the exact schema and lifecycle.

---

## 2. GÖREV 1 — the Purchase Intent system

### 2.1 Required flow, as implemented

1. **Client requests to buy/rent/hijack a specific pixel** — `POST /api/purchase-intents` (`app/api/purchase-intents/route.ts`, new) with `{ actor, actionType: "buy-listing" | "rent" | "hijack", boardId?, index, days? }`.
2. **Server verifies the pixel is actually listed and the price actually matches** — the route re-reads the LIVE pixel/board-pixel row itself (`getPixel` / `getBoardPixel`) and derives `sellerWallet` and `price`/`pricePerDay` **exclusively** from that live read. The client cannot influence price: a spoofed `price` field in the request body is never read (see the "derives price and seller EXCLUSIVELY from the live listing" test in `tests/phase3-market-security.test.ts`).
3. **Server creates a `purchase_intents` record** — `id (uuid)`, `pixel_index`, `board_id` (null = main board), `buyer_wallet`, `seller_wallet`, `currency`, `price_sol`/`price_pixel98`, `mint`, `rent_days`, `expires_at` (now + 15 minutes), `status='pending'`.
4. **Server returns the `intent_id`** in the response, along with `expiresAt` and the resolved price, for the client's UI to display and for the client to reference when it builds its Solana transaction.
5. The client references `intentId` in the payment request. *(No on-chain change was needed for this step — see §1: the binding lives server-side, not in the transaction.)*
6. **When payment reaches the API, the server acts SOLELY on `intent_id`** — `app/api/pixels/route.ts`'s `handleBuyListing`/`handleRent`/`handleHijack` (live path) no longer read an `index` field from the request body **at all** for these three actions. `resolveIntent()` looks the intent up, validates it, and every subsequent line uses `intent.pixelIndex` / `intent.sellerWallet` / `intent.priceSol` / `intent.pricePixel98` as the sole source of truth.

### 2.2 `resolveIntent` — the validation gate (identical logic in both routes)

```ts
async function resolveIntent(body, actor, expectedActionType) {
  const intentId = body.intentId;
  if (typeof intentId !== "string" || !intentId) return fail(400, "missing intentId ...");
  const intent = await getIntent(intentId);
  if (!intent) return fail(404, "purchase intent not found");
  if (intent.actionType !== expectedActionType) return fail(400, "not created for this action");
  if (intent.boardId !== null /* or !== boardId, in boards/route.ts */) return fail(400, "wrong marketplace");
  if (intent.buyerWallet !== actor) return fail(403, "belongs to a different wallet");
  if (intent.status !== "pending") return fail(409, `intent is ${intent.status}`);
  if (intent.expiresAt <= Date.now()) return fail(410, "intent has expired");
  if (intent.buyerWallet === intent.sellerWallet) return fail(400, "you already own this spot");
  return { ok: true, intent };
}
```

This is the single choke point every redemption goes through. Because `index` is read from `intent.pixelIndex` and nowhere else, **pixel/board substitution is not merely rejected by a check — it is not expressible as a request shape any more.** There is no field in the redemption request body that could carry a different target index; the only way to influence which pixel is affected is to control which intent's id is supplied, and that is gated by the wallet/status/expiry checks above.

### 2.3 Defense in depth beyond the intent record itself

Redemption additionally re-reads the *live* pixel/board-pixel state and requires `current.owner === intent.sellerWallet` (and, for priced actions, that the live price still matches what was locked into the intent) before accepting payment — a 409 "please create a new intent" if the listing changed underneath the intent (e.g. the seller re-listed at a different price, or sold it another way, between intent creation and redemption). This is a staleness guard, not a substitution guard — the substitution vulnerability (P2-F1) is closed entirely by never reading a client-submitted index; this check exists so a listing that changed doesn't get redeemed at now-stale terms.

### 2.4 `POST /api/purchase-intents` (new route)

Full request/response shape, validation, and rate limiting are in `app/api/purchase-intents/route.ts`. Notable details:

- Rate-limited (`purchase-intents:${ip}`, 60/min) — cheap to call, but not free, since it does write a DB row.
- Refuses self-targeting intents up front (`current.owner === actor` → 400) — §2.2's final check is pure defense in depth for this, since a valid pending intent can only exist if this route allowed its creation.
- Refuses a `$PIXEL98`-priced listing/hijack intent before the token is live (503), mirroring the existing `PIXEL98_MINT` gate in the payment routes.
- `rent` intents lock in a **total** price (`live per-day rate × requested days`) so redemption's staleness check can do a single scalar comparison.
- `hijack` intents deliberately **do not** lock in a cost — see §3.

---

## 3. GÖREV 2 — wiring the (dormant) Hijack mechanism into the same system

The Phase 2 report's P2-F1 finding explicitly named live-hijack as inheriting the identical substitution exposure once `$PIXEL98` activates, because the burn amount depends on the continuously-moving global `burnedFraction`. This phase closes that pre-emptively, before the token or hijack economics are ever turned on (the token is still **not** minted, and `PIXEL98_MINT` is still unset in every environment this phase touched — see the out-of-scope list in §9):

- `handleHijack`'s `tokenLive` branch (in both `app/api/pixels/route.ts` and `app/api/boards/route.ts`) now requires and resolves an intent exactly like buy-listing/rent, deriving `index` and the compensation-recipient (`sellerWallet`) from the intent.
- The **pre-launch simulated hijack path is untouched** — it spends nothing on-chain, so there is nothing to substitute a payment onto, and it continues to use `body.index` directly with its existing wallet-signed-proof + rate-limit gate.
- **The hijack cost itself is never taken from the intent.** `hijackCostInTokens(burnedFraction)` is recomputed fresh, from the live `burnedFraction`, at redemption time — exactly as it already was before this phase, and consistent with Phase 2's established principle that the server never trusts a cached/stale price. `POST /api/purchase-intents` returns a `hijackCostTokensPreview` for UI display only; it is explicitly documented in the route's own response (`note: "... recomputed fresh ... this figure is a preview only"`) and is not read back by the redemption handlers at all.
- This means a hijack intent binds **only** `(action_type='hijack', board_id, pixel_index, buyer_wallet, seller_wallet, currency='PIXEL98', mint)` — no `price_sol`/`price_pixel98`.

---

## 4. GÖREV 3 — atomic ownership + ledger writes

### 4.1 The gap (P2-F4)

Before this phase, a successful purchase performed three independent PostgREST writes in sequence: the conditional ownership `UPDATE`, then (best-effort, never-throwing, by design — see `payment-ledger.ts`/`ownership-history.ts`'s doc comments) an `INSERT` into `payment_transactions`, then an `INSERT` into `pixel_ownership_history`. That best-effort design was *correct* for its original purpose (telemetry that must never roll back a successful purchase) but is unacceptable the moment this ledger needs to be trusted for financial accounting or an airdrop snapshot: ownership could change hands with zero corresponding history row, silently.

### 4.2 The fix — one Postgres function per marketplace

`supabase/migrations/0004_purchase_intents_and_atomicity.up.sql` adds two `plpgsql` functions, `update_pixel_owner_atomic` (main board) and `update_board_pixel_owner_atomic` (Start Ads, composite `board_id`+`index` key). Each is invoked via a single `POST /rest/v1/rpc/<function>` call — PostgREST executes one function call as one Postgres transaction, so **every statement inside the function body commits together or rolls back together**:

```sql
create or replace function public.update_pixel_owner_atomic(
  p_index bigint, p_expected_owner text, p_new_data jsonb,
  p_signature text, p_wallet text, p_action text, p_amount_sol numeric, p_mint text,
  p_intent_id uuid, p_prev_owner text, p_new_owner text, p_record_history boolean
) returns table(ok boolean, reason text, data jsonb)
language plpgsql set search_path = ''
as $func$
declare v_updated jsonb; v_rows int;
begin
  update public.pixels as pix
    set data = p_new_data
    where pix.index = p_index and pix.data->>'owner' = p_expected_owner
    returning pix.data into v_updated;

  if v_updated is null then
    return query select false, 'conflict'::text, null::jsonb; return;
  end if;

  if p_intent_id is not null then
    update public.purchase_intents
      set status = 'consumed', consumed_at = now(), consumed_by_signature = p_signature
      where id = p_intent_id and status = 'pending' and expires_at > now();
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'purchase_intent_invalid: % is not a pending, unexpired intent', p_intent_id
        using errcode = 'P0002';
    end if;
  end if;

  insert into public.payment_transactions (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  if p_record_history then
    insert into public.pixel_ownership_history (pixel_index, board_id, prev_owner, new_owner, action, signature)
      values (p_index, null, p_prev_owner, p_new_owner, p_action, p_signature);
  end if;

  return query select true, null::text, v_updated;
end;
$func$;
```

`update_board_pixel_owner_atomic` is the identical shape, targeting `board_pixels` with the composite `(board_id, index)` key and writing `board_id` into the history row.

**One function call now does four things atomically:**
1. the conditional ownership `UPDATE` (same `WHERE`-guarded pattern `pixel-db-supabase.ts` already used — re-verified against the live row);
2. atomically **consuming** the purchase intent — `RAISE EXCEPTION` (which rolls back step 1 too) if it is not a pending, unexpired intent at the moment of consumption. This is *also* a second, DB-level enforcement layer for GÖREV 1: even if every application-level check were somehow bypassed, a stale/foreign/reused intent id can never be the reason ownership changes, because the RPC itself refuses to proceed without successfully consuming it;
3. the `payment_transactions` ledger insert;
4. the `pixel_ownership_history` insert, when requested (`p_record_history=false` for `rent`, which changes usage rights, not `owner` — same existing convention as `ownership-history.ts`).

`lib/server/pixel-mutations-atomic.ts` / `lib/server/board-mutations-atomic.ts` (new) wrap this RPC call behind the same `updateOwnedPixel`-shaped interface the rest of the codebase already uses, and fall back — on the file-store dev backend only, where there is no RPC endpoint — to the pre-existing sequence (`updateOwnedPixel` + best-effort ledger + best-effort intent consumption via a new `consumeIntentFileStore`), explicitly documented in that module's doc comment as a disclosed, dev-only, non-atomic limitation.

### 4.3 Two real bugs found and fixed against real staging Postgres

Both are disclosed here rather than smoothed over:

- **`function_search_path_mutable` (Supabase security advisor, WARN)** — raised immediately after `0004` was applied. Neither function set an explicit `search_path`, which the Postgres/Supabase linter flags as a hardening gap even though every table reference in both bodies was already fully schema-qualified (`public.pixels`, `public.purchase_intents`, etc. — so there was no live exploit, only a missing defense-in-depth setting). Fixed in `0004b_fix_atomic_rpc_search_path` (`ALTER FUNCTION ... SET search_path = ''`) and folded directly into the function definitions in `0004c` (below).
- **`column reference "data" is ambiguous` (real runtime failure, caught by this phase's own integration test on its first run)** — PL/pgSQL auto-declares a variable for every column named in a function's `returns table(...)` clause. Both functions declare a `data` output column, which collided with the `data` column on `public.pixels`/`public.board_pixels` inside `returning data into v_updated`. Every `buy-listing`/`rent`/live-`hijack` redemption against the Supabase backend would have failed with a 500 the first time it ran for real. Fixed in `0004c_fix_atomic_rpc_ambiguous_data_column` by aliasing the target table (`pixels as pix`, `board_pixels as bp`) and qualifying every `data` reference against that alias. Re-run of the full integration suite after this fix: all green (see §7).

This is exactly why the checklist required these tests to be run against a real database, not just designed on paper — both issues were invisible to `tsc`, `eslint`, and the mocked unit suite, and only surfaced against real Postgres.

### 4.4 Explicit scope boundary — treasury purchases stay non-atomic-with-ledger

`buy` / `buy-area` (main board) and `buy-board` (Start Ads) are **not** routed through an atomic RPC in this phase. This is a deliberate, disclosed decision, not an oversight:

- They have **no transaction-substitution exposure** — pricing is a pure function of `soldCount`/area size, never of `index`, so there is no "cheap pixel" a payment could be redirected onto (this was already proven in Phase 2's red-team suite and is unaffected by this phase).
- They are **not named** in GÖREV 1, 2, or 3's problem statements, which are specifically about peer-to-peer payments and hijack.
- They are `INSERT`-based (`createPixels`/`createBoard`), not `UPDATE`-based — a different Postgres shape that would need its own RPC design, and extending atomicity there is a reasonable candidate for a future phase, not a silent gap in this one.
- Their signature-release safety (P2-F2, Phase 2.1) was already fixed for the pixels-board handlers; this phase additionally fixed the identical, previously-unfixed P2-F2-class gap in `boards/route.ts`'s `handleBuyBoard` (bare `releaseSignature` → `releaseSignatureSafely` + `try/catch`, see §5) while touching that file, since it was directly adjacent to the work and cheap to close, but its ledger writes remain the pre-existing best-effort sequence.

---

## 5. Own-initiative scope extension: `app/api/boards/route.ts`

While designing the intent schema (deciding whether `board_id` needed to be part of it at all), `app/api/boards/route.ts`'s `handleBuyListing`, `handleRent`, and live-path `handleHijack` were found to have the **identical** P2-F1-class transaction-substitution pattern as the main board did before this phase — `verifySolTransfer`/`verifyTokenTransfer` bound only to `(actor, seller/owner, minAmount)`, never to `(boardId, index)`. This was not named in the Phase 3 brief (which named `pixels/route.ts`), but:

- GÖREV 1's own phrasing calls for a "system-wide central Purchase Intent mechanism" (*"sistem genelinde merkezi bir Purchase Intent mekanizması"*), and
- knowingly shipping a security-focused phase while leaving an identical, now-documented vulnerability unaddressed in the other marketplace would be a disclosure failure, not a scope discipline.

**Decision: extend the identical fix to boards/route.ts.** This report is that disclosure. Concretely, `app/api/boards/route.ts` received:

- The same `resolveIntent()` gate (identifying the target board **from the intent's own `board_id`**, never from the request body — closing a board-substitution vector symmetric to the pixel-substitution one, proven by the "an intent for a DIFFERENT board.exe file cannot touch another board's identically-priced sub-block" test).
- `updateBoardPixelOwnerAtomic` wired into all three handlers, same as the main board.
- A **separately disclosed, own-initiative P2-F2-class fix** in `handleBuyBoard`: it was still calling the bare, throwing `releaseSignature` with no `try/catch` around `createBoard` — the exact bug Phase 2.1 fixed in `pixels/route.ts`, but Phase 2.1 was explicitly scoped to that one file and never touched `boards/route.ts`. Fixed here (try/catch + `releaseSignatureSafely`, mirroring `pixels/route.ts`'s `handleBuy` pattern exactly) since it was directly adjacent to this phase's other boards/route.ts changes.

Boards' coverage in the unit suite is intentionally lighter than pixels' (the red-team checklist's four items are proven in full once, via the pixels route + staging integration tests; boards gets the identical fix plus confirming tests in `tests/boards-route.test.ts` and `tests/phase3-market-security.test.ts`) — disclosed here rather than silently presented as equally exhaustive.

---

## 6. Files changed / added

**New:**
- `supabase/migrations/0004_purchase_intents_and_atomicity.{up,down}.sql` — `purchase_intents` table + both RPC functions.
- `supabase/migrations/0004b_fix_atomic_rpc_search_path.{up,down}.sql` — hotfix (§4.3).
- `supabase/migrations/0004c_fix_atomic_rpc_ambiguous_data_column.up.sql` — hotfix (§4.3); no `.down.sql` (mirrors the existing `0001b_fix_documents_id_type` precedent, which is also up-only — `0004`'s own down migration already drops both functions outright on rollback, so there is nothing meaningful for `0004c` to revert to).
- `lib/server/intent-db.ts` / `intent-db-supabase.ts` — dual-backend `purchase_intents` store, same pattern as `pixel-db.ts`.
- `lib/server/pixel-mutations-atomic.ts` / `board-mutations-atomic.ts` — atomic RPC orchestration (§4.2).
- `app/api/purchase-intents/route.ts` — new REST resource (§2.4).
- `tests/phase3-market-security.test.ts` — new unit tests (intent creation, cross-route/cross-action/cross-board misuse, double-redemption).
- `tests/integration/phase3-market-security-staging.test.ts` — new integration tests, the four red-team checklist items, against real staging Postgres.

**Modified:**
- `app/api/pixels/route.ts` — `resolveIntent()` added; `handleBuyListing`/`handleRent`/`handleHijack` (live path) rewritten to require and derive everything from the intent; wired to `updatePixelOwnerAtomic`.
- `app/api/boards/route.ts` — identical rewrite (§5), plus the standalone `handleBuyBoard` P2-F2-class fix.
- `lib/server/audit-log.ts` — added `"intent_created"` to `AuditEvent`.
- `tests/pixels-route.test.ts`, `tests/boards-route.test.ts` — updated call sites that redeem buy-listing/rent/live-hijack to create an intent first (a `makeIntent` helper calling `lib/server/intent-db.ts` directly, mirroring `tests/integration/phase2-concurrency.test.ts`'s existing direct-module-call pattern).
- `tests/phase2-red-team.test.ts` — see §7 for how the now-obsolete §5 substitution tests were handled (not simply rewritten to pass).

---

## 7. Test results

### 7.1 How the (now-fixed) §5 substitution tests were handled

Per the same discipline established in Phase 2.1 ("do not simply modify an existing test to make it pass — first preserve a regression/historical record of the old behavior, then prove the new invariant"): `tests/phase2-red-team.test.ts`'s two tests that used to *assert the P2-F1 exploit succeeded* (`"buy-listing: REAL substitution risk..."`, asserting `res.status).toBe(200)` on a successful cross-listing substitution) were **not** silently flipped to expect a 4xx. They were replaced with:

- A leading comment block documenting exactly what the old vulnerable behavior was and why (kept as the historical record — see the file itself, the `HISTORICAL — finding P2-F1 (FIXED in SOL-98 Phase 3)` block).
- A new test proving the same original scenario (identical seller+price listings) now redeems only the intended pixel.
- Three new tests, one per remaining red-team checklist item, at the unit level (RED TEAM #1/#2/#3 in that file — Pixel-A-vs-Pixel-B, expired intent, foreign-wallet intent).

### 7.2 Full verification pass (this session)

```
npx tsc --noEmit                → clean
npm run lint                    → ✔ No ESLint warnings or errors
npx vitest run                  → 21 files, 204 tests passed
npm run build                   → ✓ Compiled successfully (new /api/purchase-intents route registered)
```

### 7.3 Red-team checklist — run against the REAL staging Supabase project (`hjziuadsnlofgarjsawy`, never production)

```
SUPABASE_URL=https://hjziuadsnlofgarjsawy.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<staging service-role/secret key — never written to any file> \
NODE_ENV=production \
  npx vitest run --config vitest.integration.config.mts tests/integration/phase3-market-security-staging.test.ts
```

```
✓ RED TEAM #1 — an intent created for Pixel A cannot result in ownership of Pixel B,
  even when B has an identical (seller, price)                                        PASS
✓ RED TEAM #2 — payment with an EXPIRED intent must be REJECTED (410), against
  real Postgres now() semantics                                                        PASS
✓ RED TEAM #3 — payment attempted with ANOTHER WALLET's intent_id must be
  REJECTED (403), against real Postgres row data                                       PASS
✓ RED TEAM #4 — DB RPC atomicity: a payment_transactions UNIQUE(signature)
  violation inside update_pixel_owner_atomic rolls back the ownership UPDATE
  from the SAME call                                                                   PASS

Test Files  1 passed (1)
     Tests  4 passed (4)
```

Mapped to the brief's verbatim checklist:

```
[x] User, Pixel A için intent oluşturup, Pixel B'yi satın almayı denediğinde REDDEDİLMELİ.
    → RED TEAM #1 (real staging DB: B's row is verified untouched via a direct
      PostgREST read after A's redemption succeeds)
[x] Süresi dolmuş (expired) bir intent ile yapılan ödeme REDDEDİLMELİ.
    → RED TEAM #2 (intent created with ttlMs: -1000 — expired per the DATABASE's
      own clock, not just the test process's; redemption returns 410)
[x] Başka bir cüzdanın oluşturduğu intent_id ile ödeme yapılmaya çalışıldığında REDDEDİLMELİ.
    → RED TEAM #3 (redemption attempted by a different real keypair than
      intent.buyerWallet; returns 403; pixel ownership verified unchanged)
[x] DB RPC ile Ownership + Ledger atomicity testi (Ledger constraint'e takılırsa
    ownership de rollback olmalı).
    → RED TEAM #4 (a duplicate payment_transactions.signature row is pre-inserted;
      the RPC call fails; the ownership UPDATE that ran earlier in the SAME
      function call is proven rolled back, via a direct read of the real row —
      still the original seller, not the buyer; and no ownership_history row or
      duplicate ledger row was left behind)
```

Regression check — the pre-existing Phase 1 and Phase 2 staging integration suites were re-run in full alongside this phase's new file, to confirm the new migration didn't disturb anything:

```
npx vitest run --config vitest.integration.config.mts   → 3 files, 26 tests passed
  (tests/integration/phase1-staging.test.ts,
   tests/integration/phase2-concurrency.test.ts,
   tests/integration/phase3-market-security-staging.test.ts)
```

---

## 8. Supabase security advisor

Re-run after all three `0004*` migrations: only the pre-existing `rls_enabled_no_policy` INFO items remain (now including `purchase_intents`, which follows the exact same pattern every other table in this schema already uses — RLS enabled, no policies, access exclusively via the service-role key, which bypasses RLS — not a new gap introduced by this phase). The `function_search_path_mutable` WARN raised against both new RPC functions was fixed (§4.3) and does not reappear.

---

## 9. Explicitly out of scope (unchanged from Phase 2/2.1's established boundaries)

Token launch / `$PIXEL98` mint, hijack economics/pricing formula, bonding curve, general Solana verification rules (`verify-tx.ts`'s core logic, `rpc.ts`), network guard, wallet auth (`verify-message.ts`), UI, unrelated database schema, deployment/Vercel, the Supabase **production** project (only the staging project `hjziuadsnlofgarjsawy` was touched), Start Ads economics beyond the P2-F1/P2-F2-class fixes described above, user acquisition. **On-chain/smart-contract ownership was not introduced** — every mutation in this phase is still the same off-chain-DB-plus-on-chain-payment-verification model, per the explicit constraint at the top of the brief.

---

## 10. Definition of Done

- [x] `purchase_intents` table created (staging), with the exact fields the brief specified (`intent_id`, `pixel_index`, `buyer_wallet`, `price`, `action_type`, `expires_at`, `status`).
- [x] Client → server flow: request → live-state verification → intent creation → `intent_id` returned → client references it at payment time — all six steps implemented exactly as specified.
- [x] Substitution made structurally impossible (not just checked): redemption never reads a client-submitted pixel index for the three affected actions.
- [x] Architecture choice made and documented (§1): server-side nonce, not memo, not partial-signing.
- [x] Hijack tied into the same intent infrastructure (GÖREV 2), with cost recomputed fresh at redemption (never locked into the intent).
- [x] Ownership + ledger atomicity via a Postgres RPC (GÖREV 3), proven against real Postgres transaction rollback semantics.
- [x] All four red-team checklist items coded AND run against the real staging DB — all pass.
- [x] Full verification pass (`tsc`, `lint`, unit suite, `build`) green.
- [x] Two real bugs found via staging testing, fixed, and disclosed rather than hidden (§4.3).
- [x] An independently-discovered, identical vulnerability in `boards/route.ts` disclosed and fixed (§5), including a standalone P2-F2-class gap found there.
- [x] Scope boundary for treasury purchases explicitly documented, not silently left incomplete (§4.4).
- [x] No commit, no push — working tree left as-is (§12).
- [x] This report.

## 11. Final status

**P2-F1 STATUS: FIXED.** Peer-to-peer payments (buy-listing, rent) and the dormant live-hijack path are now bound to a specific, server-issued, wallet-bound, time-bound, single-use purchase intent — proven both at the unit level (mocked verify-tx, real file-store DB) and, for the four checklist items specifically, against the real staging Postgres database.

**P2-F4 STATUS: FIXED**, for the three actions this phase touches (buy-listing, rent, hijack), on the Supabase backend. Ownership mutation, intent consumption, and ledger writes are one Postgres transaction. **Not extended** to `buy`/`buy-area`/`buy-board` (§4.4, disclosed scope boundary) and **not atomic on the file-store dev backend** (§4.2, disclosed dev-only limitation).

## 12. Working tree / commit status

No `git commit` or `git push` was performed, per standing instruction. (This environment's copy of the repository has no `.git` directory at all — confirmed again this phase, same as Phase 2's secret-scan finding.) All new and modified files remain in the working tree only. The staging Supabase project's service-role key was used exclusively as a shell-exported environment variable for the integration test runs and the migration-apply calls in this session; it was never written into any file — reconfirmed by a repository-wide grep for the key's literal value immediately before writing this report, with zero matches.
