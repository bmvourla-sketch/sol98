# SOL-98 — The On-Chain Pixel Board

Windows 98 estetiğinde, Solana üzerinde on-chain piksel tahtası. Alex Tew'in
2005 "The Million Dollar Homepage" projesinin 2026 Solana uyarlaması.

> **10,000 blocks. One mission.**

---

## Özellikler

- **Win98 masaüstü** — sürüklenebilir + yeniden boyutlandırılabilir pencereler, taskbar, Start menüsü, sistem tepsisi (saat + Solana cüzdan bağlantısı).
- **Board.exe** — 100×100 = 10.000 spotluk grid. `price(N) = 0.2 · 1.10^(N-1)` bonding curve; toplu alımlar da **aynı curve'ün tam integrali** ile fiyatlanır (bkz. Mimari notları — eski sürümde toplu alım tek fiyattan yapılıp curve'e karşı arbitraj açığı bırakıyordu, artık yok).
- **Gerçek Solana ödemesi, sunucu tarafında doğrulanmış** — her satın alma, hijack ve ikincil-piyasa işlemi, sunucunun kendi RPC bağlantısıyla zincirde bizzat doğrulamadığı sürece kabul edilmez (bkz. Güvenlik mimarisi).
- **Market.exe** — buy / rent / sell spotları; alım ve kiralama artık **doğrudan mevcut sahibe** giden gerçek SOL transferi gerektiriyor (eskiden hiç ödeme alınmıyordu). İlanlar **hem SOL hem $PIXEL98** ile fiyatlanabilir (çift para birimi); $PIXEL98 ödemeleri lansman sonrası aktifleşir.
- **Pixel Hijack** — $PIXEL98 canlıya çıktıktan sonra gerçek SPL burn ile; öncesinde imzalı-mesaj kanıtlı, hız sınırlı "simulated" mod. Yakım maliyeti **toplam arzın kademeli yüzdesi** (%1 → %0.5 → %0.25 → %0.10; toplam yakılan arz %25/%50/%75 eşiklerine göre) olup **%50'si sonsuza kadar yakılır, %50'si ele geçirilen alanın sahibine** gönderilir; her hijack hedefin değerini %5 düşürür.
- **Neon stüdyosu** — 4+ şablon (Cyberpunk Pulse / Matrix Text / Flashing Neon Border / Sub-Domain Glitch / Rainbow / Sequential) + işlem öncesi canlı önizleme.
- **PWA** — manifest + service worker, "Install SOL-98".

## Teknoloji

- Next.js 14 (App Router), React 18, Tailwind CSS 3, lucide-react
- `@solana/web3.js` + `@solana/wallet-adapter-react` + `@solana/spl-token`
- `tweetnacl` (sunucu tarafı ed25519 mesaj-imza doğrulaması)
- TypeScript (strict), ESLint (next/core-web-vitals), Vitest

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
| `NEXT_PUBLIC_SOLANA_RPC_URL` | İstemcinin işlem gönderdiği Solana RPC | Hayır (default mainnet) |
| `SOLANA_RPC_URL` | Sunucunun imza **doğrulamak** için kullandığı RPC (ayrı olması önerilir) | Hayır (yoksa `NEXT_PUBLIC_SOLANA_RPC_URL`) |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | Satın almaların düştüğü cüzdan adresi | **Evet** (canlı satış için) |
| `NEXT_PUBLIC_PIXEL98_MINT` | $PIXEL98 mint adresi (Pump.fun sonrası) | Hayır (boş → hijack simüle, imza kanıtlı) |
| `NEXT_PUBLIC_PIXELS_API_URL` | Merkezi board API ucu (default `/api/pixels`) | Hayır |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Kalıcı store (Vercel için) — pixels + documents + used-signatures | Hayır (yoksa dosya tabanlı) |

> `NEXT_PUBLIC_*` değişkenleri build sırasında gömülür — değiştirince **yeniden build** gerekir. `SOLANA_RPC_URL` client bundle'a hiç girmez.

## Doğrulama

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm test            # vitest run — bonding curve, doğrulama, replay koruması, mutex, atomiklik
npm run build       # production build
```

---

## Mimari

```
app/
  layout.tsx / page.tsx / globals.css      Win98 masaüstü + PWA meta
  api/pixels/route.ts                      action-bazlı, sunucu-doğrulamalı board API
  api/documents/route.ts                   Board.exe doküman satışı API'si
lib/
  solana.ts             RPC/treasury/mint config + lamport yardımcıları
  pricing.ts            bonding curve — spotPrice / areaPrice (gerçek integral) / totalRaisedSol
  token.ts               $PIXEL98 model (kademeli hijack yakımı, 50/50 bölünme, airdrop, toplam arz)
  server/token-stats.ts   kümülatif yakılan arz (mint supply'dan türetilir → hijack kademesi)
  pixel-types.ts          paylaşılan tipler + girdi doğrulama (link/imageUrl/mesaj/banner geometrisi)
  document-types.ts       paylaşılan doküman tipleri + doğrulama
  auth-message.ts         ücretsiz aksiyonlar için imzalanacak kanonik mesaj (client + server ortak)
  bytes.ts                base64 ⇄ Uint8Array (imza taşımak için)
  purchase.ts             gerçek tx kurucuları (SystemProgram.transfer — treasury VEYA P2P, SPL burn)
  use-solana-tx.ts        wallet-adapter sendTransaction/signMessage hook'ları
  pixel-store.tsx          client state + API senkronu (localStorage = offline cache)
  document-store.tsx       Board.exe doküman client state + API senkronu
  server/
    rpc.ts                    server-only Solana bağlantısı (doğrulama için)
    verify-tx.ts               on-chain transfer/burn doğrulama (miktar + alıcı + tazelik)
    verify-message.ts          ed25519 imzalı-mesaj doğrulama (tweetnacl)
    mutex.ts                   process-içi kilit (yazma yarışlarını engeller)
    rate-limit.ts               best-effort IP/actor bazlı hız sınırlama
    used-signatures.ts          replay koruması (bir imza sadece bir kez kabul edilir)
    supabase-env.ts             paylaşılan Supabase/PostgREST config
    pixel-db.ts / pixel-db-supabase.ts        board kalıcılığı (dosya veya Supabase)
    document-db.ts                             doküman kalıcılığı (dosya veya Supabase)
components/
  desktop.tsx / taskbar.tsx / start-menu.tsx / window.tsx / desktop-icon.tsx
  solana-wallet-provider.tsx / solana-connect-button.tsx
  pixel-board.tsx / pixel-cell.tsx / pixel-dialog.tsx / win98-alert.tsx
  market.tsx / story.tsx / whitepaper.tsx / roadmap.tsx / banner-maker.tsx
tests/            vitest birim testleri (pricing, tipler, auth, rate-limit, mutex, db atomikliği, replay)
scripts/          ikon üretimi (generate-icons.mjs)
```

## Güvenlik mimarisi — sunucu artık HİÇBİR yazıyı körü körüne kabul etmiyor

Önceki sürümde `/api/pixels` POST'u sadece `index` aralığını ve `owner`'ın
geçerli bir Solana adresi *formatında* olduğunu kontrol ediyordu — imza yok,
on-chain doğrulama yok. Sonuç: herhangi biri hiç ödeme yapmadan, doğrudan
API'ye POST atarak board'daki **herhangi bir pikseli** (başkasının gerçek SOL
ödeyerek aldığı dahil) ücretsiz ele geçirebiliyordu; ayrıca arayüzde "Pay with
SOL98" adında, hiçbir gerçek karşılığı olmayan, sınırsız-yenilenen sahte bir
bakiye ile board'daki pikselleri bedavaya satın almayı sağlayan bir buton
vardı; Market.exe'deki "Buy"/"Rent" hiç ödeme almadan sahiplik değiştiriyordu.

Yeni tasarım, her state-değiştiren aksiyon için iki kanıt türünden birini
zorunlu kılar:

1. **On-chain işlem kanıtı** (para/token hareket eden aksiyonlar — buy,
   buy-area, canlı hijack burn, market alım/kiralama): istemci gerçek bir
   Solana işlemi imzalayıp gönderir, dönen `signature`'ı API'ye yollar.
   Sunucu **kendi RPC bağlantısıyla** (`SOLANA_RPC_URL`) o işlemi zincirden
   çeker; miktarın, gönderenin ve alıcının beklenenle eştiğini, işlemin
   başarılı ve yeterince taze olduğunu doğrular (`lib/server/verify-tx.ts`).
   Her imza `used_signatures` tablosunda/dosyasında **tek kullanımlık**
   olarak işaretlenir — aynı ödeme iki kez kullanılamaz (replay koruması).
2. **İmzalı mesaj kanıtı** (ücretsiz, sahiplik-gerektiren aksiyonlar — edit,
   list/unlist, launch-öncesi simulated hijack): istemci cüzdanın
   `signMessage`'ı ile kanonik bir mesajı imzalar (para hareket etmez);
   sunucu aynı mesajı yeniden üretip imzayı `tweetnacl` ile iddia edilen
   sahibin public key'ine karşı doğrular (`lib/server/verify-message.ts`).
   Mesaj bir zaman damgası taşır ve 5 dakikadan eski kabul edilmez.

Ayrıca: fiyat her zaman **sunucuda, o anki gerçek satılan-adet üzerinden**
yeniden hesaplanır (istemcinin gösterdiği fiyat sadece önizlemedir); banner
geometrisi (`bannerCols/Rows/X/Y`) istemciden gelen değerler yerine
`indices` listesinden **sunucuda yeniden türetilir**; sahiplik kontrolleri
her zaman DEPOLANMIŞ pixel'e karşı yapılır, isteğin iddia ettiğine değil;
market alım/kiralama ödemesi **doğrudan mevcut sahibe** gider (treasury'ye
değil). Yazma yarışları (`buy`/`hijack`/vb.) process-içi bir mutex ile
(`lib/server/mutex.ts`) serileştirilir; Supabase backend'inde ayrıca
PostgREST'in `WHERE ... data->>owner=eq.X` koşullu UPDATE'i gerçek
cross-instance atomiklik sağlar.

**Bilinen sınır:** iki farklı kullanıcının aynı pikseli aynı anda
hijack/satın almaya çalışması durumunda (her ikisi de gerçek zincir işlemi
gönderdiği için) kaybeden tarafın ödemesi/burn'ü zaten zincire gitmiş olur —
tam atomiklik ancak özel bir Solana programı (escrow) ile sağlanabilir; bu
proje şu an sadece `SystemProgram`/SPL transfer'leri kullanıyor. Kaybeden
tarafın imza kanıtı sunucuda serbest bırakılır (`releaseSignature`) ve aynı
ödemeyle başka bir spota tekrar denenebilir, ama SOL/token zaten harcanmıştır.

## On-chain davranış

- **Buy / Buy Area** → `SystemProgram.transfer(payer → treasury)`, sunucuda doğrulanmış, `areaPrice` artık gerçek bonding-curve integrali.
- **Market alım (Buy Listing) / Kiralama (Rent)** → `SystemProgram.transfer(payer → GÜNCEL SAHİP)`, sunucuda doğrulanmış.
- **Hijack** → `NEXT_PUBLIC_PIXEL98_MINT` (client) + sunucunun kendi env'i doluysa gerçek SPL `createBurnInstruction`, sunucuda doğrulanmış; boşsa imzalı-mesaj kanıtlı + hız sınırlı simülasyon.
- **Edit / List for sale / List for rent / Unlist** → ücretsiz, imzalı-mesaj kanıtlı, sadece depolanmış sahibi çağırabilir.

## Merkezi board + doküman deposu (tüm kullanıcılar aynı veriyi görür)

Varsayılan olarak `data/pixels.json`, `data/documents.json`,
`data/used-signatures.json` dosyalarına yazar (tek makineli deploy:
Render/Docker/VPS için yeterli). **Vercel** serverless'ta dosya sistemi
kalıcı değildir — Supabase kullanın:

1. Supabase'te üç tabloyu oluştur:
   ```sql
   create table public.pixels (
     index bigint primary key,
     data  jsonb not null
   );
   alter table public.pixels enable row level security;

   create table public.documents (
     id bigint generated always as identity primary key,
     name text not null,
     content text not null,
     owner text not null,
     "purchasedAt" bigint not null
   );
   alter table public.documents enable row level security;

   create table public.used_signatures (
     signature text primary key,
     created_at timestamptz not null default now()
   );
   alter table public.used_signatures enable row level security;
   ```
2. Ortam değişkenlerini ayarla:
   ```bash
   SUPABASE_URL=https://<proje>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
   # PIXELS_TABLE=pixels  DOCUMENTS_TABLE=documents  SIGNATURES_TABLE=used_signatures
   ```
   Bu ikisi set edildiğinde her üç adaptör otomatik devreye girer.

> Not: Supabase yolu credentials gerektirdiği için yerelde **test edilmemiştir** — yalnızca kod-hazır ve dokümante edilmiştir; PostgREST koşullu UPDATE deseni (`?index=eq.N&data->>owner=eq.X`) production'a almadan önce kendi projenizde bir kez doğrulanmalı.

## Deploy

- **Vercel**: repo'yu bağla, `.env.local` değerlerini Vercel env'e taşı (`SOLANA_RPC_URL` ve Supabase anahtarları dahil, hiçbiri `NEXT_PUBLIC_` değil — client'a sızmaz), `build` otomatik çalışır.
- **Render/Docker**: `npm run build && npm run start`; dosya tabanlı store doğrudan çalışır (tek instance varsayımıyla — process-içi mutex birden fazla instance'a yayılmaz).

## Bilinen sınırlar

- $PIXEL98 henüz mint edilmedi → hijack burn simüle (imza kanıtlı + hız sınırlı, ücretsiz by design).
- Hız sınırlama ve process-içi mutex bellek-içidir: soğuk başlangıçta sıfırlanır, birden fazla serverless instance'a yayılmaz. Gerçek yük altında paylaşımlı bir store'a (Upstash Redis, Vercel KV) taşınmalı.
- Airdrop yalnızca tahmin (`spots × 1000`); gerçek dağıtım token çıkışında yapılacak.
- Aynı anda aynı spota yapılan iki gerçek hijack/buy denemesinde, kaybeden tarafın zincire giden ödemesi geri alınamaz (bkz. "Bilinen sınır" yukarıda) — tam atomiklik için özel bir on-chain program gerekir.
