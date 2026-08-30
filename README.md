# SOL-98 — The On-Chain Pixel Board

Windows 98 estetiğinde, Solana üzerinde on-chain piksel tahtası. Alex Tew'in
2005 "The Million Dollar Homepage" projesinin 2026 Solana uyarlaması.

> **10,000 blocks. One mission.**

---

## Özellikler

- **Win98 masaüstü** — sürüklenebilir + yeniden boyutlandırılabilir pencereler, taskbar, Start menüsü, sistem tepsisi (saat + Solana cüzdan bağlantısı).
- **Board.exe** — 100×100 = 10.000 spotluk grid. `price(N) = 0.2 · 1.10^(N-1)` bonding curve.
- **Gerçek Solana ödemesi** — satın alma, bağlı cüzdandan treasury'ye gerçek `SystemProgram.transfer` yapar (imza → onay → başarı kutusu).
- **Market.exe** — buy / rent / sell spotları; $PIXEL98 bakiyesi + airdrop tahmini.
- **Pixel Hijack** — başkasının spotunu $PIXEL98 yakarak ele geçir (değerleme −%5).
- **Neon stüdyosu** — 4 şablon (Cyberpunk Pulse / Matrix Text / Flashing Neon Border / Sub-Domain Glitch) + işlem öncesi canlı önizleme.
- **PWA** — manifest + service worker, "Install SOL-98".

## Teknoloji

- Next.js 14 (App Router), React 18, Tailwind CSS 3, lucide-react
- `@solana/web3.js` + `@solana/wallet-adapter-react` + `@solana/spl-token`
- TypeScript, ESLint (next/core-web-vitals), Vitest

---

## Kurulum

```bash
npm install
cp .env.example .env.local   # sonra kendi değerlerini gir
npm run dev                  # http://localhost:3000
```

## Ortam değişkenleri (`.env.local`)

| Değişken | Açıklama | Zorunlu |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Solana RPC (mainnet varsayılan; test için `devnet`) | Hayır (default mainnet) |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | Satın almaların düştüğü cüzdan adresi | **Evet** (canlı satış için) |
| `NEXT_PUBLIC_PIXEL98_MINT` | $PIXEL98 mint adresi (Pump.fun sonrası) | Hayır (boş → hijack burn simüle) |
| `NEXT_PUBLIC_PIXELS_API_URL` | Merkezi board API ucu (default `/api/pixels`) | Hayır |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Kalıcı board store (Vercel için) | Hayır (yoksa dosya tabanlı) |

> `NEXT_PUBLIC_*` değişkenleri build sırasında gömülür — değiştirince **yeniden build** gerekir.

## Doğrulama

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm test            # vitest run (bonding curve + token model)
npm run build       # production build
```

---

## Mimari

```
app/
  layout.tsx / page.tsx / globals.css      Win98 masaüstü + PWA meta
  api/pixels/route.ts                      GET/POST merkezi board
lib/
  solana.ts        RPC/treasury/mint config + doğrulama
  pricing.ts       bonding curve (saf fonksiyon)
  token.ts         $PIXEL98 model (hijack maliyeti, airdrop)
  purchase.ts      gerçek tx kurucuları (SystemProgram.transfer, SPL burn)
  use-solana-tx.ts wallet-adapter sendTransaction + confirm hook'ları
  pixel-store.tsx  client state + API senkronu (localStorage = offline cache)
  server/pixel-db.ts          board kalıcılığı (dosya veya Supabase)
  server/pixel-db-supabase.ts Supabase/PostgREST adaptörü
components/
  desktop.tsx / taskbar.tsx / start-menu.tsx / window.tsx / desktop-icon.tsx
  solana-wallet-provider.tsx / solana-connect-button.tsx
  pixel-board.tsx / pixel-cell.tsx / pixel-dialog.tsx / win98-alert.tsx
  market.tsx / story.tsx / whitepaper.tsx / roadmap.tsx
tests/            vitest birim testleri
scripts/          ikon üretimi (generate-icons.mjs)
```

## On-chain davranış

- **Buy** → `SystemProgram.transfer(payer → treasury)` gerçek transfer. Hazine boşsa/geçersizse işlem reddedilir.
- **Hijack** → `NEXT_PUBLIC_PIXEL98_MINT` doluysa gerçek SPL `createBurnInstruction`; boşsa **simüle** (UI'da açıkça etiketli).

## Merkezi board (tüm kullanıcılar aynı tahtayı görür)

Varsayılan olarak `data/pixels.json` dosyasına yazar (tek makineli deploy: Render/Docker/VPS için yeterli). **Vercel** serverless'ta dosya sistemi kalıcı değildir — Supabase kullanın:

1. Supabase'te tabloyu oluştur:
   ```sql
   create table public.pixels (
     index bigint primary key,
     data  jsonb not null
   );
   alter table public.pixels enable row level security;
   ```
2. Ortam değişkenlerini ayarla:
   ```bash
   SUPABASE_URL=https://<proje>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
   # PIXELS_TABLE=pixels   (varsayılan)
   ```
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` varsa adaptör otomatik devreye girer.

> Not: Supabase yolu credentials gerektirdiği için yerelde **test edilmemiştir** — yalnızca kod-hazır ve dokümante edilmiştir.

## Deploy

- **Vercel**: repo'yu bağla, `.env.local` değerlerini Vercel env'e taşı, `build` otomatik çalışır.
- **Render/Docker**: `npm run build && npm run start`; dosya tabanlı store doğrudan çalışır.

## Bilinen sınırlar

- $PIXEL98 henüz mint edilmedi → hijack burn simüle.
- Market satış/kiralama off-chain state (spec gereği).
- Airdrop yalnızca tahmin (`spots × 1000`); gerçek dağıtım token çıkışında yapılacak.
