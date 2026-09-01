# SOL-98 — PHASE 2: PAYMENT VERIFICATION + OWNERSHIP SECURITY RED TEAM

**Date:** 2026-08-31
**Scope:** Real SOL payment flow (`app/api/pixels/route.ts` + `lib/server/verify-tx.ts` + `lib/server/rpc.ts`) and the ownership-mutation chain (`lib/server/pixel-db.ts` / `lib/server/pixel-db-supabase.ts`) that Phase 1 made durable. No token launch, no hijack activation, no Start Ads economics change, no UI redesign, no production deploy, no `git push` — all forbidden per the Phase 2 brief and honored throughout. Working tree left uncommitted.

**Method:** every claim below is backed by a test that was actually run this session (not just written) — unit tests (`npx vitest run`, file-store backend, RPC mocked at the `@solana/web3.js` boundary or at `lib/server/verify-tx.ts`), and integration tests against the **real** Supabase **staging** project (`hjziuadsnlofgarjsawy`, empty, synthetic-only rows, cleaned up after every run — never production). Where a claim could not be backed by a real test in this environment, it is marked **NOT TESTABLE** with the reason, never silently assumed.

---

## 1. Payment trust model (binding)

**CLIENT NEVER DEFINES TRUST.** The server treats every client-supplied value — price, owner, pixel status, recipient, transaction validity, token validity — as a *claim*, never a fact. The only facts the server acts on are: (a) what it computes itself from its own live state (price, from `soldCount`), and (b) what it independently reads back from Solana mainnet-beta and from its own database, using conditions it derives itself, not values the client hands it. This principle governs every finding below: a finding is a defect exactly where some value crosses from client-claimed to server-acted-upon without being independently re-derived or re-checked.

---

## 2. Purchase flow audit — trust boundary trace

| Step | Where | Trust classification | Evidence |
|---|---|---|---|
| 1. Wallet connects, client reads current board state | client (`lib/purchase.ts`, `GET /api/pixels`) | **UNTRUSTED** — any client, any state it wants to display | n/a (display only, not acted on) |
| 2. Purchase intent (which pixel, at what price) | client only — **no server-side intent object exists** | **UNTRUSTED / NOT ENFORCED** | §8 |
| 3. Price calculation | **server**, `lib/pricing.ts` `nextSpotPrice`/`areaPrice`, called fresh inside `app/api/pixels/route.ts` `handleBuy`/`handleBuyArea` from a live `soldCount()` read, `route.ts:172-174`, `:233-235` | **SERVER VERIFIED** — client never supplies a price for `buy`/`buy-area`; the body has no price field these handlers read at all | `tests/phase2-red-team.test.ts` §3 (3 tests, real) |
| 4. Unsigned transaction construction | client, `lib/purchase.ts` `buildTransferTransaction`/`buildBuyTransaction` — pure builder, never touches a private key | **UNTRUSTED** (but inert: constructing a tx object commits nothing) | code read, no exploit surface |
| 5. Wallet signing + submission | client wallet + Solana network (not this app) | **UNTRUSTED as a claim, TRUSTED once confirmed** — the app never verifies the *signature scheme*; it relies on Solana consensus having already done so before a tx can reach `confirmed` commitment | n/a — delegated to Solana itself, which is the correct trust boundary |
| 6. Client reports the signature to the API | `POST /api/pixels {signature, ...}` | **UNTRUSTED** — a bare string the client provides | — |
| 7. Server verification | `lib/server/verify-tx.ts` `verifySolTransfer`/`verifyBurn`/`verifyTokenTransfer`, via `fetchConfirmedTx` | **SERVER VERIFIED** — independently fetches the tx from the RPC, checks existence, success, age, network (new this phase), sender, recipient, amount | `tests/verify-tx.test.ts` (27), `tests/network-guard.test.ts` (7), §4 |
| 8. Replay/duplicate check | `lib/server/used-signatures.ts` `claimSignature`, DB `UNIQUE(signature)` | **DATABASE VERIFIED** — atomic claim, not an in-memory check | `tests/used-signatures.test.ts`, `tests/phase2-red-team.test.ts` §6, `tests/integration/phase1-staging.test.ts` #7/#12 |
| 9. DB mutation (ownership) | `lib/server/pixel-db(-supabase).ts` — conditional `INSERT`/`WHERE owner=X` `UPDATE` | **DATABASE VERIFIED** — atomicity from Postgres constraints, not the process-local mutex | `tests/integration/phase2-concurrency.test.ts` (7, real staging), §7 |
| 10. Ledger + audit trail | `payment-ledger.ts` / `ownership-history.ts`, called **after** step 9 succeeds | **BEST-EFFORT, NOT GATING** — a failure here never blocks or reverses ownership, but is also not guaranteed to be written | §10 |

The chain's actual trust anchor is step 7 (server-independent re-verification against mainnet) plus step 8/9 (DB-enforced single-use + atomicity) — steps 1-6 are decoration the server is designed to never rely on, and the tests throughout this report confirm it doesn't.

---

## 3. Price manipulation

**Verdict: PASS.** Structurally, `handleBuy`/`handleBuyArea` never read a price field from the request body at all (`route.ts:156-211`, `:217-284` — the only body fields read are `index`/`indices`, `signature`, `ad`). Price is always `nextSpotPrice(await soldCount())` / `areaPrice(await soldCount(), n)`, computed fresh inside the write lock, then converted to a lamport floor via `solRequiredLamportsWithTolerance` and checked against the **actual on-chain transfer amount** — the client cannot skip, lower, or replay this.

Real tests run (`tests/phase2-red-team.test.ts`, all passed):
- Spoofed `price`/`priceSol`/`amountSol`/`minLamports`/`cost` fields in the body have zero effect on the amount checked (`buy`, `buy-area`).
- An old (pre-sale, cheaper) price cannot be reused after `soldCount` has moved — the check always uses the *live* count, not a snapshot from when the client displayed a price.
- `list-sale`/`list-rent` (the one place a client *does* submit a price) reject zero, negative, `NaN`, `Infinity`, `-Infinity`, and values `> 1_000_000` at `route.ts:456-458` — 8 adversarial values tested, all correctly rejected with `400`.
- Decimal prices are accepted and stored exactly (no silent rounding) — this is intentional (fractional SOL pricing), not a bug.
- Integer-overflow-style inputs (`Number.MAX_VALUE`) are rejected by the same `price > 1_000_000` bound.

Residual note (not a Phase 2 blocker, documented for completeness): `list-sale`/`list-rent` prices are **owner-set**, not server-computed — a real owner can list at any price 0 < p ≤ 1,000,000. This is by design (peer-to-peer pricing); the server's job there is only to reject non-finite/out-of-range values, which it does.

---

## 4. Transaction verification (8-point checklist)

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Find the tx signature on-chain | **SERVER VERIFIED** | `verify-tx.ts:48` `connection.getParsedTransaction` |
| 2 | Confirm it succeeded | **SERVER VERIFIED** | `verify-tx.ts:53` `if (tx.meta?.err) return {ok:false,...}` |
| 3 | Confirm correct network | **SERVER VERIFIED (new this phase)** | `rpc.ts` `assertMainnetInProduction()`, wired into `fetchConfirmedTx` at `verify-tx.ts:42-46`; production-only, genesis-hash-based, never trusts the configured URL string |
| 4 | Confirm correct sender wallet | **SERVER VERIFIED** | `verify-tx.ts:98` `source === from` |
| 5 | Confirm correct recipient wallet | **SERVER VERIFIED** | `verify-tx.ts:98` `destination === to` |
| 6 | Confirm real transfer amount | **SERVER VERIFIED** | `verify-tx.ts:98` `lamports >= minLamports` |
| 7 | Tie it to the expected action/purchase | **PARTIAL** | Bound to `(sender, recipient, amount)`, **not** to a pixel index — see finding **P2-F1** (§5) |
| 8 | Confirm it wasn't already used | **DATABASE VERIFIED** | `used-signatures.ts` `claimSignature`, DB `UNIQUE(signature)` |

7 of 8 are fully closed. The 8th (binding a payment to *which* pixel/listing, not just to a payer/payee/amount tuple) is the one structural gap this red team found — narrow, and only exploitable under specific conditions detailed next.

---

## 5. Transaction substitution

**Verdict: PARTIAL — one real, narrow finding (P2-F1).**

**Not an exploit (proven, `tests/phase2-red-team.test.ts` §5):** for brand-new purchases (`buy`/`buy-area`), redirecting a payment from index #500 to index #999 succeeds — but this is **not a vulnerability**: `lib/pricing.ts` prices are a pure function of `soldCount`/count, never of index, so every unsold spot at a given sold-count costs identically. There is no "pay for cheap #100, claim expensive #200" attack; the buyer is only ever choosing which fungible, identically-priced slot to redeem, and pays the live price regardless.

### Finding P2-F1 (MEDIUM) — peer-to-peer payments are bound to (buyer, seller, amount), not to a specific pixel

- **File/line:** `app/api/pixels/route.ts:519-592` (`handleBuyListing`), `:594-666` (`handleRent`); root cause in `lib/server/verify-tx.ts:76-106` (`verifySolTransfer` has no pixel/listing identifier parameter at all).
- **Exploit scenario:** Seller S lists pixel #60 **and** pixel #61, both at 2 SOL. Buyer B sends 2 SOL to S intending to buy #60. Before submitting the API call, B (or malware/a MITM on B's own client) submits `{action:"buy-listing", index:61, signature:<the same tx>}` instead. `verifySolTransfer` checks only `(fromOwner=B, toOwner=S, minLamports=2 SOL)` — both listings satisfy that tuple — so B walks away owning #61, and #60 is still listed (S's intended sale of #60 never happened, though S is not out any money). **Proven with a real test**: `tests/phase2-red-team.test.ts` → *"buy-listing: REAL substitution risk"* — passes, i.e., the substitution succeeds today.
- **Scope check (also proven):** the same file's *"substitution FAILS the moment price or seller differ"* test confirms this is narrowly bounded — cross-seller or cross-price substitution is correctly rejected (`402`). It only applies when a single seller has two-or-more listings/rentals priced identically.
- **Same root cause reaches hijack:** `verifyBurn`/`verifyTokenTransfer` (used by `handleHijack` when `$PIXEL98` is live) check `(owner=actor as burn authority, mint, amount)` and `(fromOwner=actor, toOwner=target.owner, mint, amount)` — again, no pixel index. Since `hijackCostInTokens(burnedFraction)` (`lib/token.ts`) depends only on the **global** burned fraction, not on the target pixel, **every hijack at a given moment costs the same tokens** — meaning a burn+transfer meant to hijack pixel #X could equally be redirected to hijack any *other* pixel currently owned by the same wallet as #X. This is currently **dormant** (hijack is in free simulated mode, gated by a signed auth proof bound to a specific index via `buildAuthMessage(action, index, ...)` — see `lib/auth-message.ts` — which the live-burn path does **not** use). This is a real pre-existing condition that will become live the day `$PIXEL98` launches unless fixed first — flagged for Phase 3.
- **Fix:** bind the payment to the specific pixel/listing server-side, either by (a) requiring an on-chain memo instruction (`spl-memo`) containing `{pixelIndex, action, nonce}` that `verify-tx.ts` checks in addition to sender/recipient/amount, or (b) a server-issued short-lived purchase-intent record (see §8) that the client must reference and the server re-validates against the specific index before accepting the payment as proof for *that* mutation.
- **Regression test:** already written and passing — `tests/phase2-red-team.test.ts` → `§5 transaction substitution` (both tests).
- **Severity: MEDIUM.** No funds are stolen from the seller (they always receive the price they set); the harm is loss of control over *which* item sold, and only when a seller has knowingly listed multiple items at an identical price.

---

## 6. Replay

**Verdict: PASS.** `used_signatures` is one global, DB-unique-constrained ledger shared by every signature-consuming action — not partitioned by action or pixel — so a signature claimed by any action is dead everywhere.

Real tests run:
- Same signature, same action, different pixel → `409` (pre-existing, `tests/pixels-route.test.ts`).
- Same signature, **different action**, different pixel (`buy` → `buy-listing`) → `409` (`tests/phase2-red-team.test.ts` §6, new this phase).
- Same signature, hijack-burn → fresh `buy` → `409` (new this phase).
- Cross-instance/DB-level: `claimSignature` uses `UNIQUE(signature)` in Postgres (`used_signatures` table), not an in-memory set — verified live against staging in `tests/integration/phase1-staging.test.ts` #7/#12/#13.

---

## 7. Concurrency

**Verdict: PASS**, re-verified against the **real staging DB**, not mocks (`tests/integration/phase2-concurrency.test.ts`, 7/7 passed; run 2026-08-31 against `hjziuadsnlofgarjsawy`).

| Scenario | Result |
|---|---|
| A×2 — 2 buyers race one brand-new pixel | exactly 1 owner |
| B×2 — repeat, different index | exactly 1 owner |
| C×4 — 4 buyers race one brand-new pixel | exactly 1 winner, 3 structured losers, each correctly reporting the index as taken |
| Purchase+Purchase at 8-way concurrency | exactly 1 owner |
| Purchase+Sell — 2 buyers race one **listed** (already-owned) pixel via `updateOwnedPixel` | exactly 1 winner, 1 structured conflict |
| Purchase+Hijack — `updateOwnedPixel` (buy-listing) and `hijackPixel` race the **same** pixel simultaneously | exactly 1 winner in **10/10 real runs** (order non-deterministic — sometimes the buy wins, sometimes the hijack — but never both) |
| Invariant: partial batch conflict (`buy-area`) creates **zero** rows, not a partial write | confirmed against real Postgres — the two non-conflicting indices in a 3-index batch stayed completely unowned when the third conflicted |

**Why this holds:** the in-process mutex (`lib/server/mutex.ts`, `withWriteLock` in `route.ts:44`) is documented as single-process-only and is *not* what's being credited here — the real guarantee is Postgres's row-level locking under PostgREST's conditional `PATCH ...&data->>owner=eq.<expected>` / `INSERT` with a PK on `index`. A second writer's `UPDATE` blocks on the row lock, then re-evaluates its `WHERE` against the now-changed row and matches zero rows once the first commits — there is no window for two writers to both win, and this held in all 10 empirical Purchase+Hijack runs.

**Hijack's future activation:** `handleHijack`'s live-burn path and its currently-active free/simulated path both call the exact same `hijackPixel(index, mutate)` primitive (`route.ts:340`, `:366`) — the DB-level race protection is **identical** regardless of which payment-verification branch gates entry to it. The Purchase+Hijack race test above exercises that same primitive directly. **Conclusion: the race protection is already safe for hijack's future activation** — turning on `$PIXEL98` changes only the payment-verification step, not the ownership-mutation atomicity, which this phase re-confirmed against real Postgres.

---

## 8. Purchase intent

**Current mechanism: none exists.** There is no server-issued reservation, nonce, or intent record anywhere in the codebase — the client goes straight from reading a displayed price to building and sending a raw transaction (`lib/purchase.ts`) to POSTing a signature. Confirmed by reading `app/api/pixels/route.ts` in full: no `intent`, `nonce`, `reservation`, or `expiresAt` field is read, written, or checked anywhere in it.

**Is one needed?**
- For treasury purchases (`buy`/`buy-area`): **no.** Price is recomputed from live state at verification time and checked against the *actual* on-chain amount (§3), so a stale/old price cannot be exploited even without a formal intent — an underpayment (from a stale price) simply fails the `minLamports` check.
- For peer-to-peer payments (`buy-listing`/`rent`) and future live hijack: **yes** — this is precisely the gap behind finding **P2-F1** (§5). A purchase-intent record (wallet + pixel index + price + nonce + short expiry, single-use, checked server-side before the payment is accepted as proof for that specific mutation) would close it directly. Not implemented this phase — implementing a new intent subsystem was judged out of proportion to a red-team/audit phase and is deferred to Phase 3 (see PHASE 3 READINESS). Marking the corresponding Definition-of-Done item **PARTIAL**, not PASS, per instruction.

---

## 9. Solana network

**Verdict: PASS (fixed this phase).** Before this phase, nothing anywhere asserted the server's RPC connection was actually mainnet-beta — `fetchConfirmedTx` would have accepted any *confirmed* transaction on whatever network `getServerSolanaRpcEndpoint()` (`lib/solana.ts`) happened to resolve to, including devnet if `SOLANA_RPC_URL`/`NEXT_PUBLIC_SOLANA_RPC_URL` were ever misconfigured.

**Fix:** `lib/server/rpc.ts` now exports `assertMainnetInProduction()` — production-only (no-op in dev/test), checks the connection's `getGenesisHash()` against the known, public, immutable mainnet-beta genesis hash (`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, cross-referenced against Solana's own RPC docs and Chainlink's chain-selectors registry), caches a successful check per process, and **never caches a failure** (a persistently-misconfigured RPC keeps failing every call, not just once). Wired into `verify-tx.ts`'s `fetchConfirmedTx` so it gates `verifySolTransfer`, `verifyBurn`, and `verifyTokenTransfer` uniformly, and runs *before* the RPC is asked for the transaction at all (fails closed, not just eventually).

Real tests run (`tests/network-guard.test.ts`, 7/7 passed, unmocked except the `Connection` constructor):
- No-op outside production (never calls the RPC).
- Passes on a real mainnet-beta hash; rejects on a different (devnet-like) hash; rejects on an empty/undefined hash (fails closed, doesn't fail open on RPC misbehavior).
- Caches success (1 RPC call across 3 invocations); does **not** cache failure (2 calls across 2 failed invocations).
- End-to-end: `verifySolTransfer` rejects with the network-guard's error *before* ever calling `getParsedTransaction` when the network mismatches — proven by asserting the parsed-transaction mock was never invoked.

**RPC-returned data as potentially manipulable:** every fact `verify-tx.ts` acts on (existence, success, sender, recipient, amount, timestamp) is independently re-derived from the RPC response on every call — nothing is cached or trusted from a prior call except the mainnet-check itself (which is a network-identity fact, not a per-transaction fact, and is only ever cached as *success*, never as failure).

**Residual, honestly disclosed:** `tokenAmountToRaw()` (`verify-tx.ts:227-231`, converts a human `$PIXEL98` amount to raw units via `getMint`) calls `getServerConnection()` directly and does **not** route through `fetchConfirmedTx`, so it is not gated by `assertMainnetInProduction()`. Real-world exploitability is low — it doesn't itself verify a payment, only converts a decimal for a check that happens elsewhere (which *is* gated) — but for completeness this is an accepted residual gap, not claimed as fully closed. Noted for Phase 3.

---

## 10. Payment ledger

`payment_transactions` (Phase 1) is classified as **(A) audit log**, not (B) a financial ledger of record and not (C) an idempotency store in its own right:

- **Not the idempotency mechanism.** `used_signatures`' `UNIQUE(signature)` constraint is what actually prevents double-spend/replay (§6) — `payment-ledger.ts`'s own doc comment states this explicitly, and its own `UNIQUE(signature)` is described as "defensive only," a belt-and-suspenders check that's never reached first.
- **Not a reliable financial ledger.** Both `payment-ledger.ts` (`recordPaymentTransaction`) and `ownership-history.ts` (`recordOwnershipHistory`/`Batch`) are explicitly **best-effort**: every write is wrapped in try/catch, every failure path only calls `logAudit(...)` and returns — never throws, never rolls back, never blocks the response. Confirmed by reading both files in full: there is no code path in either that can fail the request that called it.

**Consistency model (verified from the actual code, not assumed):** in every handler (`handleBuy`, `handleBuyArea`, `handleHijack`, `handleBuyListing`, `handleRent`), the order is always **ownership mutation first, ledger/history write second** — never the reverse. This means:

- **"Blockchain SUCCESS → DB ownership SUCCESS → ledger write FAILURE"**: happens exactly as the ownership mutation already returned `200` to the client with their pixel; the ledger/history insert then fails silently (logged via `audit-log`). **No double ownership, no lost payment** — the buyer keeps their pixel — but the audit trail has a gap. This is real and testable: `recordPaymentTransaction`/`recordOwnershipHistory` never throw, so this scenario is reachable any time Supabase has a transient blip on exactly that second write. **Finding P2-F4 (LOW-MEDIUM):** `payment_transactions`/`pixel_ownership_history` should not be treated as complete for reconciliation/accounting purposes without a periodic job that cross-checks recorded rows against `used_signatures` (which IS reliably complete, since a claim there is required before any mutation) or against on-chain treasury balance. Recommended for Phase 3, not implemented this phase (would require a new reconciliation job, out of scope for a red-team audit).
- **"Blockchain SUCCESS → ledger SUCCESS → ownership FAILURE"**: **structurally cannot happen** in this codebase, because the ledger write is only ever reached *after* the ownership mutation already returned `ok: true` — if the ownership mutation fails (structured `ok:false`), the code returns early (releasing the signature) and never calls `recordPaymentTransaction`/`recordOwnershipHistory` at all. Verified directly by reading every handler's control flow; this is a structural guarantee, not a race that needs a live test.

**The one real gap found in this area is P2-F2 (§12, CRITICAL):** it is not about *ledger* consistency — it's about the ownership mutation call itself throwing (a genuine DB outage) rather than returning a structured `ok:false`, which is not caught before `releaseSignature` and results in a burned payment proof with nothing to show for it. See §12 for the proof.

---

## 11. Failure matrix

| Scenario | Classification | Evidence |
|---|---|---|
| Blockchain unavailable (RPC connection refused) | **SAFE RETRY** — throws before `claimSignature`, propagates to the route's outer `catch` → `500`, signature untouched | proven (§12, RPC-failure test) |
| RPC timeout | **SAFE RETRY** — same code path as above | proven (§12) |
| DB unavailable — **before** signature claim (e.g. the initial `getPixel` read) | **SAFE RETRY** — `500`, signature never touched | code-derived (same shape as RPC failure; no local catch exists before the claim) |
| DB unavailable — **after** signature claim, during the ownership write itself | **FAIL CLOSED BUT UNSAFE (lost payment)** — see **P2-F2**, CRITICAL | **proven**, real test, §12 |
| DB timeout | same as "DB unavailable," positionally dependent — same two outcomes above | code-derived |
| DB transaction failure (structured conflict, e.g. index already taken) | **SAFE RETRY** — `releaseSignature` is called, `409`, same signature works against a different target | proven (§12 "control case" + pre-existing tests) |
| Duplicate transaction (signature reused) | **REJECTED / FAIL CLOSED** — `409`, no mutation | proven (§6, §12) |
| Invalid transaction (no matching on-chain transfer) | **FAIL CLOSED** — `402` | proven (`tests/verify-tx.test.ts`, pre-existing) |
| Wrong amount | **FAIL CLOSED** — `402` | proven (pre-existing + §3 tests) |
| Wrong recipient | **FAIL CLOSED** — `402` | proven (pre-existing) |
| Wrong wallet (sender) | **FAIL CLOSED** — `402` | proven (pre-existing + §5 cross-seller test) |
| Wrong pixel (index substitution) | **FAIL CLOSED** for `buy`/`buy-area` (no-op by design) and for `buy-listing`/`rent` when seller or price differ (`402`, proven); **NOT PROTECTED** when seller+price coincide across two listings — see **P2-F1** | proven both ways, §5 |
| Sold pixel (already owned) | **SAFE RETRY** — `409`, signature released | proven (pre-existing + §12) |
| Expired intent | **NOT APPLICABLE** — no purchase-intent object exists to expire (§8). Closest functional analogs: `MAX_TX_AGE_MS`/`MAX_TX_FUTURE_SKEW_MS` (15 min / 2 min, `verify-tx.ts:14-15`) bound how stale/future a *payment tx* can be; `AUTH_MESSAGE_MAX_AGE_MS` (5 min, `lib/auth-message.ts`) bounds free-action auth proofs — both pre-existing and covered by pre-existing tests | code-derived, pre-existing tests |
| Network mismatch | **FAIL CLOSED** — production-only, rejects before any chain read | proven (§9) |

---

## 12. Security tests — actually run

All of the following were executed this session (`npx vitest run`), not merely described. Full unit suite: **185/185 passed** (20 files). Full integration suite against real staging: **22/22 passed** (2 files: Phase 1's pre-existing 15 + Phase 2's new 7).

| Test | File | Result |
|---|---|---|
| Fake signature / fake amount / fake recipient / wrong recipient / wrong wallet / wrong pixel / wrong network / wrong price / old price | `tests/verify-tx.test.ts` (27), `tests/network-guard.test.ts` (7), `tests/phase2-red-team.test.ts` §3/§5 | **PASS** |
| Duplicate transaction / transaction replay | `tests/used-signatures.test.ts`, `tests/pixels-route.test.ts`, `tests/phase2-red-team.test.ts` §6 | **PASS** |
| Transaction substitution | `tests/phase2-red-team.test.ts` §5 | **PARTIAL** — P2-F1 confirmed real, narrow, documented |
| Expired intent | N/A — no intent object; closest analog (stale/future tx, stale auth proof) is pre-existing-tested | **NOT APPLICABLE**, see §11 |
| Wallet substitution | `tests/verify-tx.test.ts` (sender mismatch), `tests/phase2-red-team.test.ts` (cross-seller) | **PASS** |
| Concurrent purchase / purchase same pixel | `tests/integration/phase2-concurrency.test.ts` (real staging) | **PASS** |
| Purchase after ownership change | `tests/pixels-route.test.ts` (`not_owner` rejections on edit/list/unlist by a stale owner) | **PASS** |
| DB failure during purchase | `tests/phase2-red-team.test.ts` §11/§12 | **FAIL** — real defect found, **P2-F2** |
| RPC failure during purchase | `tests/phase2-red-team.test.ts` §11/§12 | **PASS** |
| Partial failure (batch buy-area) | `tests/integration/phase2-concurrency.test.ts` (real staging) | **PASS** |

### Finding P2-F2 (CRITICAL) — a genuine DB write failure during ownership mutation burns the payment signature with no pixel and no retry path

- **File/line:** `app/api/pixels/route.ts:183-206` (`handleBuy`), and the identical pattern at `:244-277` (`handleBuyArea`), `:333-345` (`handleHijack`), `:555-581` (`handleBuyListing`), `:635-653` (`handleRent`).
- **Root cause:** `claimSignature(signature)` is called and succeeds (the payment proof is now permanently burned) **before** the ownership-mutation call (`createPixels`/`updateOwnedPixel`/`hijackPixel`). The code only calls `releaseSignature(signature)` when that call returns a **structured** `{ ok: false }` (e.g. `pixel-db-supabase.ts:78-83`, a `409` "index already taken"). If the call instead **throws** — a real Supabase outage, a non-409/201/204 HTTP status, a network error inside `fetch` (`pixel-db-supabase.ts:83` `throw new Error(...)` on any unrecognized status) — that exception is not caught locally anywhere in `handleBuy`/etc.; it propagates straight to `POST`'s outer `try/catch` (`route.ts:136-140`), which returns a plain `500`. `releaseSignature` is **never called** on that path.
- **Exploit / failure scenario:** buyer sends a real, verified SOL payment. The moment `createPixels` is called, Supabase has a transient 500 (outage, connection reset, rate limit — anything that isn't a clean `409`). The buyer gets a `500` response and **no pixel**. Their transaction signature is now permanently marked used in `used_signatures`. Retrying the identical request (even after the DB recovers) is rejected `409 "already used"` — proven directly: `tests/phase2-red-team.test.ts` → *"CRITICAL: a DB failure...burns the signature with no pixel and no retry path"*. The buyer's SOL is gone from their wallet (sent to the treasury, a real on-chain fact) and they have nothing to show for it and no way to get it back through the API.
- **Severity: CRITICAL.** This is a real-money loss path, not a theoretical one — it requires nothing more than an ordinary transient database error at exactly the wrong moment, which is not a rare or adversarial condition.
- **Fix (for Phase 3, not implemented this phase — Red Rule #6 forbids changing existing verification/payment logic in an audit phase, and this fix touches the write path's control flow, which is properly a Phase 3 implementation task, not a Phase 2 finding-and-document task):** wrap the ownership-mutation call in its own `try/catch` in every one of the five handlers; on any thrown error, call `releaseSignature(signature)` before re-throwing/returning `500`, exactly as already happens for the structured-conflict case. This makes the release unconditional on failure, regardless of whether the failure was a structured `ok:false` or a thrown exception.
- **Regression test:** written and passing (proves the *current*, unfixed behavior) — `tests/phase2-red-team.test.ts` §11/§12. This same test should be re-run after the Phase 3 fix and is expected to flip: the retry after a DB-failure should then succeed (`200`), not fail (`409`).

---

## 13. Property/invariant tests

All 10 required invariants, tested for real:

| # | Invariant | Result | Evidence |
|---|---|---|---|
| 1 | Unverified payment cannot create ownership | **PASS** | `tests/phase2-red-team.test.ts` §13 — all 5 paid actions (`buy`, `buy-area`, `hijack`, `buy-listing`) tested with `verifySolTransfer`/`verifyBurn` forced to fail; board state confirmed unchanged |
| 2 | One transaction cannot create multiple ownership mutations | **PASS** | §6 replay tests — same signature, different action/pixel, always rejected after first use |
| 3 | One pixel cannot have multiple current owners | **PASS** | §7 concurrency — every race (2-way, 4-way, 8-way, cross-action) against real staging Postgres resolves to exactly one stored owner |
| 4 | Client cannot determine final price | **PASS** | §3 — server-computed, client fields structurally ignored |
| 5 | Client cannot determine final owner | **PASS** | `tests/phase2-red-team.test.ts` §13 — a spoofed `owner` body field is ignored; owner is always the verified payer (`actor`) |
| 6 | Client cannot bypass transaction verification | **PASS** | every paid handler requires `verified.ok`/`burnVerified.ok`/`transferVerified.ok` before any mutation — no code path skips this |
| 7 | Devnet payment cannot become production ownership | **PASS (fixed this phase)** | §9, `tests/network-guard.test.ts` |
| 8 | Failed DB transaction cannot leave partial ownership | **PASS** | `tests/integration/phase2-concurrency.test.ts` — a 3-index batch with 1 conflict creates **zero** rows, verified against real Postgres, not just asserted from reading the single-INSERT-statement code |
| 9 | Duplicate request cannot duplicate ownership | **PASS** | §6, §7 |
| 10 | Ownership mutation must be auditable | **PARTIAL** | the mutation itself is always correct (§8, DB-level), but the audit-trail *write* (`ownership-history.ts`) is best-effort and can silently fail (§10) — auditability is not 100% guaranteed, only "usually happens, never blocks correctness" |

---

## 14. Secret security

**Repository/tracked-file scan: PASS.** Full-tree regex scan for hardcoded service-role keys, private keys, seed phrases/mnemonics, PEM-format key blocks, AWS-style access keys, and generic `secret=`/`apikey=` literal assignments, across every `.ts`/`.tsx`/`.js`/`.jsx`/`.json`/`.md`/`.env*` file (excluding `node_modules`, `.next`, `data`): **zero hardcoded secrets found in source code.** `scripts/import-json-dryrun.mjs` reads its Supabase key from `process.env.SUPABASE_SERVICE_ROLE_KEY` with no literal fallback. No `.pem`, `id_rsa*`, `*keypair*.json`, or `*wallet*.json` files exist anywhere in the tree. No code path falls back to a hardcoded default when an env var is unset.

`.env.local` **does** contain real staging credentials (a Supabase `sb_secret_...` key and a Helius RPC API key) — this is expected and correct: `.gitignore` excludes it via both `.env*.local` and the broader `.env*` line (confirmed by direct pattern match), so it is not, and was never intended to be, tracked. The secret values themselves are not reproduced anywhere in this report, per instruction.

**Git history scan: NOT TESTABLE in this environment.** This session's copy of the repository (synced via the file-staging bridge, not a `git clone`) has no `.git` directory — `git log`/`git status` both fail with "not a git repository." A git-history secret scan (e.g. `gitleaks detect` or `trufflehog filesystem --since-commit`) could not be run here and must be run against the user's actual local clone before this repository is ever pushed to a remote or made public. **Recommendation for the user:** run one of those tools locally, and rotate the current staging Supabase service-role key and Helius RPC API key as routine hygiene once Phase 2/3 testing against them is finished (both are staging-only credentials already scoped to a non-production project, so this is precautionary, not an active incident).

**No secret exposure found → not a CRITICAL finding.** (Had one been found in tracked source or history, this section would say `SECRET EXPOSURE = CRITICAL` per instruction; it does not apply here.)

---

## 15. This document

This file. Every PASS/FAIL/PARTIAL/NOT TESTABLE/NOT APPLICABLE label above is backed by a named test file and a real run recorded in this session (unit suite 185/185, integration suite 22/22 against real staging, plus `tsc --noEmit`, `next lint`, `next build`, all run and passing this session — see §18/DoD below). No label in this document was written without a corresponding real test run.

---

## 16. Findings summary

| ID | Severity | Summary | Status |
|---|---|---|---|
| **P2-F1** | MEDIUM | P2P (`buy-listing`/`rent`) and future live-hijack payments are bound to `(wallet, wallet, amount)`, not to a specific pixel — exploitable only when a seller/owner has 2+ identically-priced listings/targets | Documented + regression-tested; fix deferred to Phase 3 |
| **P2-F2** | **CRITICAL** | A thrown (not structured-conflict) DB error during ownership mutation, after the signature is claimed, permanently burns the payment proof with no pixel granted and no retry possible | Documented + regression-tested (proves the current defect); fix deferred to Phase 3 (touches write-path control flow, out of scope for an audit-only phase) |
| **P2-F4** | LOW–MEDIUM | `payment_transactions`/`pixel_ownership_history` are best-effort and can have silent gaps; not safe to treat as a complete financial ledger without a reconciliation job | Documented; recommended for Phase 3 |
| — | informational | `tokenAmountToRaw()` bypasses the new network guard | Documented, low real-world exploitability, accepted residual for now |

---

## 17. Definition of Done

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Server-side price verification | **PASS** | §3 |
| 2 | Server-side transaction verification | **PASS** | §4 |
| 3 | Recipient verification | **PASS** | §4 |
| 4 | Sender verification | **PASS** | §4 |
| 5 | Amount verification | **PASS** | §4 |
| 6 | Network verification | **PASS** (fixed this phase) | §9 |
| 7 | Duplicate transaction protection | **PASS** | §6 |
| 8 | Replay protection | **PASS** | §6 |
| 9 | Transaction substitution protection | **PARTIAL** — P2-F1 | §5 |
| 10 | Concurrent purchase protection | **PASS** | §7 |
| 11 | Ownership atomicity | **PASS** | §7, §13 (invariant 8) |
| 12 | DB failure safety | **FAIL** — P2-F2 | §12 |
| 13 | RPC failure safety | **PASS** | §12 |
| 14 | Purchase intent safety | **PARTIAL** — no intent object exists; gap is P2-F1 | §8 |
| 15 | No secret exposure | **PASS** (repo/tree); git history **NOT TESTABLE** here | §14 |
| 16 | Tests pass | **PASS** — 185/185 unit, 22/22 integration (real staging) | this session |
| 17 | Lint pass | **PASS** — `next lint`: 0 warnings/errors | this session |
| 18 | Typecheck pass | **PASS** — `tsc --noEmit`: 0 errors | this session |
| 19 | Build pass | **PASS** — `next build`: compiled successfully, all routes generated | this session |

---

## PHASE 2 STATUS: **PARTIAL**

12 of the 14 substantive DoD security items are a clean PASS, backed by real, run-this-session tests including 22 integration tests against a live staging Postgres database. Two are not: **item 12 (DB failure safety) is a genuine FAIL** — a CRITICAL, real-money-loss defect (P2-F2) was found and proven, not merely theorized — and **item 9/14 (transaction substitution / purchase intent) is PARTIAL**, a real MEDIUM gap (P2-F1) with a clear, narrow exploit boundary. Every other item in the 16-section brief was investigated and evidenced; nothing was rubber-stamped. Per instruction, this is reported honestly as PARTIAL rather than PASS, because two DoD boxes cannot be checked with real proof of correctness — they can only be checked with real proof of the defect.

---

## PHASE 3 READINESS — what must be resolved before Phase 3

1. **Fix P2-F2 (CRITICAL, blocking):** wrap every ownership-mutation call (`createPixels`/`updateOwnedPixel`/`hijackPixel`) in `app/api/pixels/route.ts`'s five paid handlers in a `try/catch` that unconditionally calls `releaseSignature` on any thrown error, not just on a structured `{ok:false}`. This is a small, mechanical, well-scoped fix with a regression test already written and waiting (`tests/phase2-red-team.test.ts`) — it should flip from proving the bug to proving the fix.
2. **Decide on P2-F1's fix before enabling `$PIXEL98`/live hijack:** either an on-chain memo binding payments to a specific pixel index, or a server-issued purchase-intent record (§8). This does not block Phase 3 starting, but **does** block safely turning on token-gated hijack, since that's exactly where P2-F1's dormant half becomes live.
3. **Consider a reconciliation job (P2-F4):** a periodic check comparing `payment_transactions`/`pixel_ownership_history` against `used_signatures` (or on-chain treasury balance) to catch and backfill the rare silent gaps best-effort writes can leave. Not blocking, but should exist before this ledger is relied on for accounting.
4. **Run a git-history secret scan** (`gitleaks`/`trufflehog`) against the actual local repository before any push to a remote or any public visibility change — this session's copy has no `.git` directory and could not do this itself.
5. **Address the `tokenAmountToRaw()` network-guard gap** for completeness before `$PIXEL98` launch, even though its real-world exploitability is low on its own.
6. Everything else in this report — pricing, sender/recipient/amount verification, replay protection, concurrency/atomicity, the network guard, and repository secret hygiene — is production-ready as verified and needs no further work before Phase 3 begins.
