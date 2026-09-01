# SOL-98 — PHASE 2.1: P2-F2 CRITICAL PAYMENT-SAFETY FIX

**Date:** 2026-08-31
**Scope:** exactly one objective — fix P2-F2 (a database ownership-write exception after a successful payment-signature claim permanently burned the payment proof, leaving the buyer with neither ownership nor a retry path). No token launch, no hijack activation, no economics change, no deploy, no push, no other refactor. Working tree left uncommitted.

---

## 1. Previous vulnerable control flow

In every one of the five paid handlers in `app/api/pixels/route.ts`, the shape was:

```text
claimSignature(signature)   // burns the payment proof — single use, DB-unique
        ↓
ownershipMutation(...)      // createPixels / updateOwnedPixel / hijackPixel
        ↓ (only checked structurally)
if (!result.ok) { releaseSignature(signature); return 409 }
        ↓
recordPaymentTransaction / recordOwnershipHistory (best-effort)
        ↓
return 200
```

`releaseSignature` was only ever reached from the `if (!result.ok)` branch — a **structured** failure (e.g. `createPixels` returning `{ ok: false, taken: [...] }` when an index was genuinely already sold). Nothing wrapped the mutation call itself in `try/catch`. If the mutation instead **threw** — a real Supabase outage, a non-`201/204/409` HTTP status (`pixel-db-supabase.ts` throws `Error("supabase insert failed: ${status}")` / `"supabase update failed: ${status}"` for anything it doesn't recognize), or a network-level `fetch` failure — that exception propagated straight past the release logic to `POST`'s outer `try/catch` (`route.ts`, previously lines 136-140), which returned a plain `500`. `releaseSignature` was never called on that path.

## 2. Exact root cause

The `if (!result.ok) { ...release... }` pattern only handles one of the two ways a promise can settle. A JavaScript `await` on a rejecting promise skips every subsequent line in its `try`-less block and jumps to the nearest enclosing `catch` (here, the route's outer one) — the structural check on `.ok` is never reached, so the code that releases the signature never runs.

## 3. Files changed

- `lib/server/used-signatures.ts` — added `releaseSignatureSafely()`, a non-throwing wrapper around the existing (unmodified) `releaseSignature()`. Added an `audit-log` import for its failure logging. No existing export's behavior was changed.
- `app/api/pixels/route.ts` — for each of the five paid handlers (`handleBuy`, `handleBuyArea`, `handleHijack`'s live-burn path, `handleBuyListing`, `handleRent`): wrapped the ownership-mutation call in `try/catch`; on a thrown error, releases the signature and re-throws the **original** error (preserving its message for logging/response); the pre-existing structured-conflict branch is untouched in logic, only its release call now goes through the safe wrapper. Swapped the `releaseSignature` import for `releaseSignatureSafely`.
- `tests/phase2-red-team.test.ts` — restructured the DB-failure test block into Tests A-E per the fix's required proof (see §6).

**Not changed:** pricing, `$PIXEL98` mint/economics, hijack activation, bonding curve, Solana verification rules (`verify-tx.ts`, `rpc.ts`), wallet auth (`verify-message.ts`), UI, database schema, any Supabase project, Start Ads. The free/simulated hijack path (`handleHijack`'s non-`tokenLive` branch, `route.ts`) and the four free owner-only actions (`edit`, `list-sale`, `list-rent`, `unlist`) don't consume a payment signature at all and were correctly left untouched — there is nothing for them to release.

## 4. Exact fix strategy

Minimal, mechanical, and scoped to the mutation call site only — no new subsystem, no change to response codes or messages for the structured-conflict case, no change to `claimSignature`/`releaseSignature`'s own semantics:

```ts
let created: Awaited<ReturnType<typeof createPixels>>;
try {
  created = await createPixels([pixel]);
} catch (error) {
  await releaseSignatureSafely(signature, { action: "buy", wallet: actor, index });
  logAudit("db_failure", { where: "createPixels", action: "buy", wallet: actor, index, error: ... });
  throw error; // preserves the ORIGINAL error for the outer catch's 500 response
}
if (!created.ok) {
  await releaseSignatureSafely(signature, { action: "buy", wallet: actor, index });
  logAudit("ownership_conflict", { action: "buy", wallet: actor, index });
  return fail(409, "..."); // unchanged message
}
```

Applied identically (adapted to each handler's own mutation call and existing message text) to all five handlers. `Awaited<ReturnType<typeof fn>>` was used instead of importing each backend's result type, to keep the diff to the call site only.

`releaseSignatureSafely` (`used-signatures.ts`):

```ts
export async function releaseSignatureSafely(signature: string, context: Record<string, unknown> = {}): Promise<void> {
  try {
    await releaseSignature(signature);
  } catch (error) {
    logAudit("db_failure", { where: "releaseSignature", signature, ...context, error: ... });
  }
}
```

Why a wrapper instead of calling `releaseSignature` directly in the new `catch` blocks: `releaseSignature`'s **Supabase/production** path already never throws (its `DELETE` is wrapped in `.catch(() => undefined)`), but its **file-store/dev** path can throw on a real disk error. Without this wrapper, a release failure inside our new `catch` block would replace the original mutation error with an unrelated release error before it reaches the client — violating the explicit instruction to preserve the original error. `releaseSignatureSafely` is used consistently in **both** the new thrown-error branch and the pre-existing structured-conflict branch (a strict improvement: previously an unguarded `releaseSignature()` call in the structured-conflict branch could itself turn a clean `409` into a `500` on the file-store backend; that residual gap is now also closed, in scope since it's the same signature-release call site this fix already touches).

## 5. Five-handler audit table

| Handler | claim | mutation | thrown error caught | release on throw | release on structured failure | success remains consumed |
|---|---|---|---|---|---|---|
| `handleBuy` | `route.ts:183` | `createPixels` `:209` | ✅ try/catch | ✅ `:211` | ✅ `:222` | ✅ proven (Test D) |
| `handleBuyArea` | `route.ts:263` | `createPixels` `:292` | ✅ try/catch | ✅ `:294` | ✅ `:305` | ✅ proven (pre-existing replay coverage; same `claimSignature` mechanism) |
| `handleHijack` (live-burn path) | `route.ts:367` | `hijackPixel` `:379` | ✅ try/catch | ✅ `:381` | ✅ `:392` | ✅ proven (Test E — hijack) |
| `handleBuyListing` | `route.ts:605` | `updateOwnedPixel` `:617` | ✅ try/catch | ✅ `:633` | ✅ `:644` | ✅ proven (Test E — buy-listing) |
| `handleRent` | `route.ts:701` | `updateOwnedPixel` `:712` | ✅ try/catch | ✅ `:721` | ✅ `:732` | ✅ proven (Test E — rent) |

Not applicable (no payment signature involved, correctly untouched): the free/simulated hijack path (`route.ts:416`, gated by a signed auth proof, not a tx signature), and `edit`/`list-sale`/`list-rent`/`unlist` (`:481`, `:510`, `:537`, `:554`, all owner-only and auth-proof-gated).

## 6. Tests added/changed

`tests/phase2-red-team.test.ts`, describe block `"PHASE 2.1 — P2-F2 fix: DB exception after claim no longer burns the signature"` (new), plus the pre-existing RPC-failure test kept as-is:

- **Test A** — `buy`: a thrown `createPixels` error releases the signature, creates no ownership (`GET` confirms), and still surfaces as a real `500` with the real error message (not a fake conflict).
- **Test B (most important)** — `buy`: after Test A's failure, retrying the **exact same signature** once the mock is removed (DB "recovered") now returns `200` with ownership granted — this used to return `409 "already used"`.
- **Test C** — `buy`: a genuine structured conflict (index really taken) still releases the signature for retry against a different target — proves the pre-existing, correct behavior is unchanged.
- **Test D** — `buy`: a successful mutation still permanently consumes the signature — a replay attempt still gets `409 "already used"`. Guards against the fix accidentally releasing successful payments.
- **Test E** (one per remaining handler) — `buy-area`, `hijack` (live-burn path, mocked — `$PIXEL98` is **not** activated, only the already-existing token-live code branch is exercised with `verifyBurn`/`verifyTokenTransfer` mocked exactly as the rest of the suite already does), `buy-listing`, `rent`: each proves the identical thrown-error → release → successful-retry sequence for that handler's own mutation call.

The historical failure concept is preserved in the block's leading comment (not as a still-passing "old" test, since the old assertion — retry returns `409`— is now the *wrong* behavior by design; per the instructions, the concept is documented in prose and the new tests prove the fixed invariant directly, which is the stronger and more useful form of "regression test" here: it fails loudly if the bug is ever reintroduced).

## 7. Test results (all run this session)

| Command | Result |
|---|---|
| `npx vitest run tests/phase2-red-team.test.ts` | **21/21 passed** |
| `npx vitest run` (full unit suite) | **191/191 passed**, 20 files |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **0 warnings/errors** |
| `npm run build` | **compiled successfully**, all routes generated |
| `npx vitest run --config vitest.integration.config.mts` (real staging DB, `hjziuadsnlofgarjsawy`, synthetic rows only, cleaned up after) | **22/22 passed** (Phase 1's 15 + Phase 2's 7 — confirms the DB-layer atomicity this fix sits on top of is unaffected, since `pixel-db-supabase.ts` itself was not modified) |

## 8. Retry-after-failure proof

Directly demonstrated, per the required proof statement — *"same verified payment signature → ownership DB failure → retry with same signature → successful ownership"* — for **every** paid handler:

- `buy`: Test B. `createPixels` throws once (simulated DB outage) → `500` → same signature retried after the mock is removed → `200`, `pixel.owner === buyer`.
- `buy-area`: Test E. Same pattern, `createPixels` on a 4-pixel batch → `200`, all 4 pixels returned.
- `hijack` (live-burn path): Test E. `hijackPixel` throws once → `500` → same signature retried → `200`, `pixel.owner === hijacker`.
- `buy-listing`: Test E. `updateOwnedPixel` throws once → `500` → same signature retried → `200`, `pixel.owner === buyer`.
- `rent`: Test E. `updateOwnedPixel` throws once → `500` → same signature retried → `200`, `pixel.rentedTo === renter`.

All five ran and passed this session (part of the 21/21 in `tests/phase2-red-team.test.ts`).

## 9. Release-failure analysis

Investigated, per the instruction not to invent a false guarantee:

- **Supabase/production path** (`used-signatures.ts` `releaseSignature`, lines ~73-79): the `DELETE` request is already wrapped in `.catch(() => undefined)` and the code never inspects `res.ok`/`res.status`. This means `releaseSignature` **never throws** on this path — but it also means a failed `DELETE` (e.g. Supabase returns a `500`, or the request itself fails at the network level) is **silently treated as success**: the signature row can remain in `used_signatures`, permanently claimed, with the caller none the wiser. `releaseSignatureSafely` cannot detect or fix this, because the failure is already invisible one layer down, inside `releaseSignature` itself — there is nothing for the wrapper's own `try/catch` to catch. **This is a real, residual gap**: in the rare case where the *mutation* fails AND the subsequent release *also* fails (e.g. a sustained Supabase outage affecting both calls), the signature can still end up stuck. This is strictly narrower than P2-F2 (which fired on *every* single mutation failure, not just the compound case of mutation-failure-and-release-failure occurring together), and is now the accepted residual risk — documented rather than fixed, since closing it fully would require changing `releaseSignature`'s own Supabase logic to check `res.ok`, which was judged a separate, larger change outside a single-objective critical-fix phase (candidate for Phase 2.2 or 3).
- **File-store/dev path**: `releaseSignature`'s file-store branch (no Supabase configured) has no `try/catch` around its `fs.mkdir`/`fs.writeFile`/`fs.rename` calls, so it **can** throw on a real disk error. This is exactly what `releaseSignatureSafely` protects against — confirmed by code reading; not separately load-tested (would require inducing a real disk fault, out of scope), but the wrapper's `try/catch` is generic and covers any exception type this path can produce.
- **Net effect:** the fix's actual, verified guarantee is: *a thrown ownership-mutation error will trigger an honest attempt to release the signature, and that attempt's own failure (if any) will never be silently mistaken for success at the call site, nor will it replace the original error shown to the client.* It does **not** newly guarantee that release always succeeds against Supabase specifically — that guarantee was already this weak before Phase 2.1 (via `releaseSignature`'s pre-existing `.catch(() => undefined)`), and fixing it is out of this phase's single-objective scope.

## 10. Remaining risks

- The Supabase-path release-failure gap in §9 (residual, narrower than P2-F2, not fixed this phase).
- `handleBuyArea`'s success-remains-consumed property was verified via the existing `claimSignature` single-use mechanism (shared code path with `buy`, already proven by Test D and pre-existing tests) rather than a dedicated new replay test for `buy-area` specifically — judged sufficient since the consumption logic isn't handler-specific, but noted for completeness.
- No change was made to `payment-ledger.ts`/`ownership-history.ts` best-effort semantics (Phase 2 finding P2-F4) or to the transaction-substitution finding (P2-F1) — both are explicitly out of scope for this single-objective phase and remain open per the Phase 2 report's Phase 3 readiness list.

## 11. P2-F2 status

```text
P2-F2 STATUS: FIXED
```

Proven by Test B and its four Test-E siblings in `tests/phase2-red-team.test.ts` (run this session, 21/21 passing): for every one of the five paid handlers, a verified payment signature that hits a thrown ownership-mutation error is released, the failure surfaces honestly as a `500`, and the exact same signature can then be retried successfully once the underlying failure clears — it is no longer rejected as `"already used"`. Successful mutations still permanently consume their signature (Test D), and structured conflicts still behave exactly as before (Test C). Full unit suite (191/191), integration suite against real staging (22/22), typecheck, lint, and build all pass.
