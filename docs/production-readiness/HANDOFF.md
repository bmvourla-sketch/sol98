# HANDOFF — kaldığımız yerden devam (2026-09-01)

## Proje
SOL-98 — Win98 görünümlü Solana pixel reklam tahtası ("Million Dollar Homepage" klonu).
- Repo: `C:\Users\pc\Desktop\sol98`
- Remote: `https://github.com/bmvourla-sketch/sol98.git` · branch `main` @ `6a5aa8d`
- Stack: Next.js 14 (App Router), React 18, TS, Tailwind, Vitest.
- Canlı: `https://sol98.toolsomniai.com/` (Vercel; tahta BOŞ — 0 satış).

## Şu ana kadar yapılan (commit'li)
- **Ana tahta**: 100×100 = 10.000 blok, bonding curve 0.2 SOL +%10/satış.
- **Market**: al/sat/kirala (P2P, mevcut sahibe), çift para birimi (SOL + $PIXEL98).
- **Hijack**: kademeli yakım (%1→%0.5→%0.25→%0.10, 10M arz), 50/50 bölünme (yarısı yakılır, yarısı ele geçirilen alanın sahibine), %5 değer düşüşü.
- **Start Ads**: board.exe dosyaları, 2 SOL +%10 curve, 10×10 mini tahta, aynı mekanikler + rename.
- **Cüzdan**: Win98 stilli, cüzdan logoları (adapter.icon), network-mismatch hata mesajı.
- **Zoom (SON DURUM)**: tekerlek = kaydırma, Ctrl+tekerlek = imlece zoom, pinch = zoom. (commit `0b89367` + `e689523`)
- Testler: **159/159** geçer (vitest `fileParallelism:false` — testler ortak `data/` kullanır).

## Docs (working tree'de COMMIT'LENMEDİ — push edilmedi)
- `docs/production-readiness/PHASE-0-AUDIT.md` — tam denetim (3 blocker).
- `docs/production-readiness/PHASE-1-DATABASE.md` — DB tasarımı + dürüst FAIL durumu.
İkisi de Phase 1 kırmızı kuralları ("deploy/push yapma") gereği commit'lenmedi.

## AKTİF GÖREV: Phase 1 — Production DB + kalıcı sahiplik
**Durum: FAIL (BLOCKED).** Sebep: bu ortamda Supabase kimlik bilgisi yok.

Kırmızı kurallar (kullanıcıdan): production'da JSON fallback YASAK; fail-closed; mevcut sistemi körlemesine yeniden yazma; auth/payment/tokenomics'i bu fazda değiştirme; secret'ları repo'ya yazma; önce staging'de doğrula; deploy/push YAPMA.

### Sıradaki adımlar (sırayla)
1. **Kullanıcı bir Supabase projesi sağlayacak** (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — BLOKE EDEN BU.
2. `0001_ownership_integrity.sql` migration'ını uygula (`payment_transactions` + `pixel_ownership_history` + indexler; şema PHASE-1-DATABASE.md §3'te).
3. `lib/server/supabase-env.ts`'e `requireDurableStore()` ekle (production'da fail-closed).
4. Her WRITE fonksiyonunun başına çağır (pixel-db, board-db, document-db, used-signatures).
5. Atomik sahiplik: conditional UPDATE (`index=eq.N & data->>owner=eq.PREV`) → cross-instance güvenli, JS mutex yok.
6. Idempotency: `payment_transactions.signature` UNIQUE.
7. Server-side ownership history (ownership değişimiyle aynı tx'te yaz).
8. 17 testlik matrisi staging'de koş (14'ü gerçek DB ister).
9. Staging'de backup/restore drill'i.
10. Production gate checklist'ini gerçek kanıtla doldur.

## Phase 0 — 3 BLOCKER (gerçek paradan önce şart)
1. Kalıcı DB yok (tüm state `data/*.json`'da, Vercel'de geçici).
2. "On-chain sahiplik" iddiası YANLIŞ (Story/Whitepaper; gerçekte merkezi JSON/Supabase).
3. Bedava hijack (token canlı değil, Sybil'e açık) ödenmiş pixel'leri bedavaya çalabilir.

## Komutlar
- `npm run typecheck` / `npm test` / `npm run build` — hepsi `6a5aa8d` itibarıyla yeşil.

## Ortam bilgileri
- `.env.local`: `SOLANA_RPC` = mainnet Helius; `TREASURY_ADDRESS` set; `PIXEL98_MINT` = BOŞ (token canlı değil).
- `SUPABASE_URL` / `SERVICE_ROLE_KEY` HİÇBİR YERDE YOK.
- `data/` gitignore'da ve bu working tree'de boş.
