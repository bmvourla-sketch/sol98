# SOL-98 — PHASE 0: PRODUCTION READINESS BASELINE AUDIT

**Date:** 2026-09-01
**Scope:** Full repository audit (app/, components/, lib/, API routes, data layer, auth, wallet, Solana verification, payments, ownership, buy/sell/rent, hijack, $PIXEL98, Start Ads, Board.exe, bonding curve, banner maker, PWA, mobile, tests, docs, env, deploy config).
**Method:** Read-only. No code was modified. Every finding is traced to a file; anything not directly observed is marked `UNKNOWN — REQUIRES VERIFICATION`.

---

## VERDICT

The project has a **genuinely strong security model** (wallet-signature auth, server-side on-chain verification, replay protection) and a **polished Win98 UI**. It is **NOT production-ready** for the single reason that dominates everything else: **there is no durable database in production.** All user state is written to a local filesystem that is ephemeral on Vercel. Combined with a free "simulated hijack" that can strip any paid pixel at zero cost, and a false "on-chain ownership" claim, this cannot accept real money yet.

---

## A. PRODUCTION DATABASE — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| A1 | **CRITICAL** | No durable DB in production. All stores fall back to local JSON files. | `.env.local` has no `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (verified). `lib/server/supabase-env.ts` → `isSupabaseConfigured()` = `Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)` → false. |
| A2 | **CRITICAL** | Filesystem is ephemeral on Vercel serverless. | Live site `server: Vercel` (verified via HTTP header). Stores use `path.join(process.cwd(), "data")` — `lib/server/pixel-db.ts`, `board-db.ts`, `document-db.ts`, `used-signatures.ts`. |
| A3 | **CRITICAL** | Every user mutation (purchase, hijack, list, rent) is written to non-persistent storage. | `pixel-db.ts` `createPixels`/`updateOwnedPixel`/`hijackPixel` persist to `data/pixels.json`; `board-db.ts` → `data/boards.json`. |
| A4 | **INFO** | `/data` is correctly git-ignored (no accidental commit of user data). | `.gitignore` contains `/data`. |
| A5 | **UNKNOWN** | Supabase backend is "code-ready but untested" — the SQL table setup is documented but never exercised in this environment. | `README.md` "Bilinen sınırlar"; `lib/server/pixel-db-supabase.ts` present but unreachable without env keys. |

---

## B. OWNERSHIP — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| B1 | **HIGH** | Ownership is a plain `owner` string field in a JSON record — NOT on-chain. | `lib/pixel-types.ts` `PixelData.owner`; `lib/board-types.ts` `BoardPixel.owner`. |
| B2 | **INFO** | Identity is verified correctly (wallet pubkey from signed tx / signMessage). | `app/api/pixels/route.ts` `parsePubkey`; `lib/server/verify-message.ts` `verifyAuthProof` (tweetnacl ed25519). |
| B3 | **INFO** | Payment→ownership link is server-verified: price recomputed, tx verified on-chain, then `createPixels`/`updateOwnedPixel` writes owner. | `app/api/pixels/route.ts` `handleBuy`/`handleBuyArea`/`handleBuyListing`. |
| B4 | **CRITICAL** | Ownership does NOT survive redeploy (follows from A1/A3). | — |

---

## C. PAYMENTS — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| C1 | **INFO (good)** | SOL payment verified on-chain, server-side, against a confirmed tx with amount/recipient/freshness checks. | `lib/server/verify-tx.ts` `verifySolTransfer`, `fetchConfirmedTx` (15-min age bound). |
| C2 | **INFO (good)** | Recipient is checked (treasury vs P2P owner). | `verifySolTransfer` `toOwner` param. |
| C3 | **INFO (good)** | Replay prevented via single-use signature ledger. | `lib/server/used-signatures.ts` `claimSignature` (Set + 409 on Supabase). |
| C4 | **MEDIUM** | 0.5% under-payment tolerance lets a buyer pay slightly less. | `lib/server/verify-tx.ts` `solRequiredLamportsWithTolerance(toleranceFraction=0.005)`. |
| C5 | **HIGH** | Replay/double-spend protection is per-instance: two concurrent Vercel lambdas can both pass `claimSignature` before either writes (the in-process `mutex` does not span instances). | `app/api/pixels/route.ts` `withWriteLock` + `lib/server/mutex.ts`; README admits "process-içi mutex birden fazla instance'a yayılmaz". |
| C6 | **UNKNOWN** | `$PIXEL98` token payment is implemented but inactive (mint empty). | `NEXT_PUBLIC_PIXEL98_MINT` = empty (verified). |

---

## D. HIJACK — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| D1 | **CRITICAL** | Hijack is currently **simulated and FREE** — a signed message with no burn grants ownership of any pixel/block. | `app/api/pixels/route.ts` `handleHijack` simulated path; `app/api/boards/route.ts` same. |
| D2 | **HIGH** | Rate limit is in-memory, per-wallet (5/10min), and Sybil-able (unlimited free wallets). | `lib/server/rate-limit.ts` (in-memory Map); `pixels-hijack-sim:${actor}` 5/10min. |
| D3 | **HIGH** | No real economic cost to hijack before token launch. | D1 + `PIXEL98_MINT` empty. |
| D4 | **INFO** | Live hijack (tiered burn + 50/50 split + 5% decay) is correctly wired but dormant. | `lib/token.ts` `HIJACK_BURN_TIERS`/`splitHijackBurn`; `verifyBurn`/`verifyTokenTransfer`. |

---

## E. $PIXEL98 — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| E1 | **CRITICAL** | Token does NOT exist yet (`PIXEL98_MINT` empty) → all token features are dead/inactive. | `.env.local` `NEXT_PUBLIC_PIXEL98_MINT = EMPTY` (verified). |
| E2 | **HIGH** | Roadmap/UI mark token features as shipped while inactive. | `components/roadmap.tsx` `[x] SOL + $PIXEL98 payments (dual currency…)`; UI shows "after launch" but roadmap says shipped. |
| E3 | **MEDIUM** | No devnet/mainnet split — a single `PIXEL98_MINT`/`TREASURY_ADDRESS` pair is used for everything. | `lib/solana.ts`. |
| E4 | **INFO** | `TOTAL_SUPPLY = 10_000_000` matches whitepaper "10,000,000 fixed" and airdrop 1000×10k. | `lib/token.ts`; `components/whitepaper.tsx`. |

---

## F. START ADS — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | **INFO** | Board.exe = 10×10 = 100 blocks. | `lib/board-types.ts` `BOARD_FILE_SIZE = 10`, `BOARD_FILE_BLOCKS = 100`. |
| F2 | **INFO** | 2 SOL bonding curve (+10%/sale). | `lib/board-types.ts` `BOARD_FILE_START_PRICE_SOL = 2`, `boardFilePrice(n)=2·1.10^(n-1)`. |
| F3 | **MEDIUM** | "Start Ads" is absent from whitepaper/roadmap/README (docs not synced with code). | grep of whitepaper/roadmap — no "Start Ads"/"board.exe" mention. |
| F4 | **MEDIUM** | Duplicate mechanics: `app/api/boards/route.ts` is a near-copy of `pixels/route.ts` (buy/list/rent/hijack/rename) — every fix must be applied twice. | file comparison. |
| F5 | **LOW** | "10 blocks" size was interpreted as 10×10=100 without confirmed product spec. | `lib/board-types.ts`. |

---

## G. SECURITY — FINDINGS (threat-by-threat)

| Threat | Verdict | Evidence |
|---|---|---|
| authentication bypass | **Not found** — strong wallet-signature auth | `verify-message.ts`, `verify-tx.ts` |
| authorization bypass | **Not found** — ownership re-checked vs stored state | `updateOwnedPixel(expectedOwner)`, `updateBoardPixel` |
| replay | **Mitigated (single-instance only)** | `used-signatures.ts` |
| race condition (concurrent purchase/hijack) | **HIGH (cross-instance)** | in-process mutex only |
| double spend / duplicate tx | **HIGH (cross-instance)** | C5 |
| TOCTOU | **Present (cross-instance)** | signature claim vs write gap across lambdas |
| CSRF | **Mitigated** — wallet signature binds actor+action+timestamp | `auth-message.ts` |
| XSS (stored) | **LOW footgun** — SVG data-URI allowed in image | `lib/pixel-types.ts` `isSafeImageUrl` allows `data:image/svg+xml` |
| SSRF | **Not found** — no server-side fetch of user URLs | — |
| injection | **Not found** — no SQL string building (PostgREST HTTP, parameterized) | `pixel-db-supabase.ts`, `used-signatures.ts` |
| rate-limit bypass | **HIGH** — in-memory, sybil-able, per-instance | `rate-limit.ts` |
| sybil attack | **HIGH** — free hijack + unlimited wallets | D1/D2 |
| wallet spoofing | **Not found** — pubkey from verified signature/tx | — |
| signature reuse | **Mitigated (single-instance)** | `claimSignature` |
| transaction spoofing | **Not found** — tx fetched from chain by server | `fetchConfirmedTx` |
| price manipulation | **Not found** — price recomputed server-side | `nextSpotPrice`, `areaPrice` |
| ownership race | **HIGH (cross-instance)** | mutex per-process |
| admin privilege escalation | **Not found** — no admin surface exists | — |

---

## H. MOBILE — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| H1 | **HIGH** | Drag-to-select uses mouse events only → broken on touch. | `components/pixel-cell.tsx` `onMouseDown/onMouseEnter`; `pixel-board.tsx` `onMouseUp`. |
| H2 | **HIGH** | Native browser zoom is disabled (`maximumScale: 1`) — accessibility issue. | `app/layout.tsx` viewport. |
| H3 | **MEDIUM** | 10,000 DOM nodes (100×100 grid) — heavy on low-end mobile. | `pixel-board.tsx` `cells` (TOTAL_SPOTS loop). |
| H4 | **INFO** | Pinch-zoom added (custom touch events) but coexists with H2's native-zoom block. | `pixel-board.tsx` `touchmove` handler. |
| H5 | **INFO (good)** | Windows use Pointer Events (drag/resize) — touch-friendly. | `components/window.tsx` `startDrag`/`startResize`. |

---

## I. CODE QUALITY — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| I1 | **MEDIUM** | Dead code: document-sale stack orphaned (removed from Start menu, still fully present). | `components/document-sale.tsx`, `lib/document-store.tsx`, `lib/document-types.ts`, `lib/server/document-db.ts`, `app/api/documents/route.ts`, `DocumentProvider` + `board` WindowId in `desktop.tsx`. |
| I2 | **MEDIUM** | Duplicate API routes (boards vs pixels). | `app/api/boards/route.ts` ≈ `app/api/pixels/route.ts`. |
| I3 | **MEDIUM** | Brand inconsistency: "S98" (logo), "$PIXEL98" (token), "SOL-98" (product), domain sol98.toolsomniai.com. | `components/start-menu.tsx`, `lib/token.ts`, `app/layout.tsx`. |
| I4 | **LOW** | No security headers (CSP) configured; `poweredByHeader:false` set. | `next.config.mjs`. |

---

## J. DOCUMENTATION — FINDINGS

| # | Severity | Finding | Evidence |
|---|---|---|---|
| J1 | **HIGH** | "On-chain / permanent / provably yours" claims in Story/Whitepaper are false (state is centralized). | `components/story.tsx`, `components/whitepaper.tsx`, `README.md`. |
| J2 | **MEDIUM** | Roadmap marks "$PIXEL98 payments" and PWA as `[x]` shipped while token is absent. | `components/roadmap.tsx`. |
| J3 | **MEDIUM** | "Start Ads" system missing from all docs. | F3. |
| J4 | **INFO** | Whitepaper tokenomics (10M supply, airdrop 1000×spot, hijack tiered burn) are consistent with code. | `components/whitepaper.tsx` vs `lib/token.ts`. |

---

## SUMMARY

### 1. BLOCKERS (must fix before any real money)
1. **No durable DB** — all state ephemeral on Vercel (A1/A2/A3/B4).
2. **False "on-chain" ownership claim** (J1/Critical).
3. **Free hijack strips paid pixels at zero cost** (D1/D2/D3).

### 2. HIGH PRIORITY
1. Cross-instance race/double-spend (C5, G race/TOCTOU).
2. Token features marked shipped while inactive (E2/J2).
3. Mobile drag-select broken (H1).
4. `maximumScale: 1` accessibility (H2).

### 3. MEDIUM PRIORITY
1. Dead document-sale stack (I1).
2. Duplicate route logic (I2).
3. Brand inconsistency (I3).
4. SVG XSS footgun (G).
5. Docs omit Start Ads (J3).

### 4. LOW PRIORITY
1. 0.5% payment tolerance (C4).
2. Missing CSP headers (I4).
3. 10,000 DOM nodes perf (H3).

### 5. LAUNCH READY (verified working / strong)
- Wallet-signature auth + on-chain verification + replay protection (single-instance).
- Bonding-curve pricing math.
- Win98 UI, windows, PWA assets (manifest.json, sw.js, icons all present).
- Tiered-burn + 50/50 split tokenomics (wired, dormant).
- Test suite (17 files / 159 tests, after `fileParallelism:false` fix).

### 6. NOT LAUNCH READY
- **No** — cannot accept real payments until a durable DB is connected and verified in production, the free-hijack hole is closed, and the "on-chain" claims are corrected.

---

## CHANGED FILES

This audit was read-only. **No source files were changed.**
- Created: `docs/production-readiness/PHASE-0-AUDIT.md` (this report).
- No other files were modified, migrated, refactored, or deployed.
