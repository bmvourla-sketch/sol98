# SOL-98 — PHASE 5: PRODUCTION DEPLOYMENT, TOKEN MINT & FINAL SMOKE TEST

**Durum:** Doğrulama tamamlandı. Bu doküman canlıya geçiş için üç şeyi verir: (1) mevcut Supabase projesinin migration/RLS/güvenlik durumunun canlı sorgularla doğrulanmış raporu, (2) Vercel production env var kontrol listesi (kod içinde gerçekte okunan değişken adlarıyla, mevcut `.env.local`'daki set/eksik durumuyla), (3) ilk-saat smoke test planı ve olay/rollback prosedürleri.

**Kapsam dışı:** Bu faz hiçbir kod veya migration değişikliği içermiyor — sadece doğrulama, dokümantasyon ve kontrol listesi. Kod commit/push edilmedi, working tree'de bırakıldı (talimat gereği).

---

## 1) Özet — Canlıya Hazır mıyız?

Kısa cevap: **backend/veritabanı tarafı evet, "production" ortamı henüz hayır.**

- Şu an kullanılan Supabase projesi (`Sol-98`, ref `hjziuadsnlofgarjsawy`) Phase 1-4 boyunca **staging** olarak kullanıldı. Hesapta bu projeden başka, bu uygulamayla ilgisi olmayan tek bir proje daha var (`Bahçe Mangal`, ref `nxsaajqswyqzovwniuge`) — yani şu anda **ayrı, adanmış bir production Supabase projesi yok**. Aşağıdaki §2'deki tüm doğrulamalar bu staging projesine karşı yapıldı.
- İki seçenek var: (a) bu staging projesini production olarak "terfi ettirmek" (aynı proje, gerçek parayla), ya da (b) yeni, ayrı bir production Supabase projesi açıp aynı 8 migration'ı oraya da uygulamak. Karar kullanıcıya ait — §2.4'te her iki yol için de somut adımlar var.
- Mainnet ortam değişkenlerinden **treasury adresi ve RPC URL şu an set**, ama **$PIXEL98 mint adresi henüz boş** (token daha mint edilmedi — beklenen durum) ve **sunucu tarafı doğrulama RPC'si (`SOLANA_RPC_URL`) da boş**, yani doğrulama trafiği şu an public Ankr endpoint'i üzerinden gidiyor. Bkz. §3.

---

## 2) GÖREV 1 — Production Supabase Migration Kontrolü

### 2.1 Hangi proje?

`mcp__Supabase__list_projects` ile hesaptaki projeler listelendi:

| Proje | ref | Durum | Not |
|---|---|---|---|
| Sol-98 | `hjziuadsnlofgarjsawy` | ACTIVE_HEALTHY | Phase 1-4 boyunca kullanılan staging projesi — bu fazda doğrulanan proje budur |
| Bahçe Mangal | `nxsaajqswyqzovwniuge` | ACTIVE_HEALTHY | Bu uygulamayla **ilgisi yok** — asla kullanılmamalı |

Ayrı bir production projesi yok. Bu, brief'te istenen "production veritabanı" kontrolünün şu an fiilen staging projesi üzerinde yapıldığı anlamına geliyor — karar için bkz. §2.4.

### 2.2 Migration Zinciri Doğrulaması

`mcp__Supabase__list_migrations` ile canlı projeye uygulanmış migration'lar sorgulandı. Sonuç — **8 migration, sırayla, eksiksiz uygulanmış:**

| Sıra | Version (timestamp) | Ad | Yerel dosya (`supabase/migrations/`) var mı? |
|---|---|---|---|
| 1 | 20260831220809 | `0001_core_tables` | ✅ `0001_core_tables.up.sql` / `.down.sql` |
| 2 | 20260831220817 | `0002_board_tables` | ✅ `0002_board_tables.up.sql` / `.down.sql` |
| 3 | 20260831220822 | `0003_ownership_integrity` | ✅ `0003_ownership_integrity.up.sql` / `.down.sql` |
| 4 | 20260831221900 | `0001b_fix_documents_id_type` | ❌ **repo'da dosya yok — bkz. aşağıdaki bulgu** |
| 5 | 20260831234630 | `0004_purchase_intents_and_atomicity` | ✅ `0004_purchase_intents_and_atomicity.up.sql` / `.down.sql` |
| 6 | 20260831234716 | `0004b_fix_atomic_rpc_search_path` | ✅ `0004b_fix_atomic_rpc_search_path.up.sql` / `.down.sql` |
| 7 | 20260831235409 | `0004c_fix_atomic_rpc_ambiguous_data_column` | ⚠️ sadece `.up.sql` var, `.down.sql` yok |
| 8 | 20260901101358 | `0005_treasury_purchase_atomicity` | ✅ `0005_treasury_purchase_atomicity.up.sql` / `.down.sql` |

**Brief'te istenen "0001_initial → 0005" sırası doğrulandı: evet, eksiksiz ve sırayla işlenmiş.** İki küçük bulgu var (kritik değil, ama production'a geçmeden kayıt altına alınmalı):

**Bulgu A — `0001b_fix_documents_id_type` repo'da dosya olarak yok.** Canlı DB'de uygulanmış (documents.id kolonunu hatalı `bigint identity`'den doğru `text`'e çeviren bir düzeltme, Phase 1 sırasında staging'de bulunmuş), ama repodaki `0001_core_tables.up.sql` zaten güncellenmiş halde `id text primary key` içeriyor — yani dosya, DB geçmişindeki adımı "yerinde" düzeltilmiş olarak taşıyor. Sonuç: **yeni/boş bir veritabanına bu migration dosyalarını sırayla uygularsanız doğru şemaya ulaşırsınız** (0001b'ye gerek kalmadan), ama mevcut staging DB'sinin `supabase_migrations.schema_migrations` geçmişi ile repo dosyaları birebir eşleşmiyor. Eğer §2.4'te "aynı projeyi production yap" yolu seçilirse bu sorun değil (DB zaten doğru halde). Eğer "yeni production projesi aç" yolu seçilirse de sorun değil (dosyalar zaten doğru sonucu üretiyor). Sadece CLI tabanlı bir migration-sync aracı (`supabase db diff` vb.) kullanılırsa bu tutarsızlık kafa karıştırabilir — öneri: `0001b` dosyasını da repoya (belgesel amaçlı, no-op) eklemek.

**Bulgu B — `0004c_fix_atomic_rpc_ambiguous_data_column.up.sql`'in `.down.sql`'i yok.** Diğer tüm migration'lar up/down çifti halinde; bu biri asimetrik. Rollback gerekirse `0004c`'yi geri almak için elle bir `.down.sql` yazılması gerekecek — şu an yok. Kritiklik düşük (0004c yalnızca 0004'teki bir kolon belirsizliğini düzeltiyor, RPC'lerin kendisini silmiyor) ama tamlık için eklenmesi önerilir.

### 2.3 RLS ve `search_path = ''` Doğrulaması

**RLS:** `mcp__Supabase__get_advisors(type=security)` çalıştırıldı. Sonuç: 8 tablonun **hepsinde RLS enabled**, ama hiçbirinde policy yok (`rls_enabled_no_policy`, seviye INFO). Bu **kod tasarımıyla tutarlı ve doğru**: uygulama hiçbir yerde client-side Supabase client'ı (`@supabase/supabase-js`, `createClient`, `NEXT_PUBLIC_SUPABASE_*`) kullanmıyor — grep ile `app/`, `components/`, `lib/` altında sıfır eşleşme doğrulandı. Tüm okuma/yazma sadece server-side API route'ları üzerinden, `SUPABASE_SERVICE_ROLE_KEY` ile (RLS'yi bypass eder) yapılıyor. Yani RLS + policy yok kombinasyonu, olası bir anon-key sızıntısı durumunda dahi hiçbir satırın dışarıdan okunamamasını garanti ediyor — bu bilinçli, savunma-derinliği amaçlı bir durum, eksiklik değil. (Advisor seviyesi zaten sadece INFO, WARN/ERROR değil.)

Tablolar: `pixels`, `board_pixels`, `board_files`, `documents`, `payment_transactions`, `pixel_ownership_history`, `purchase_intents`, `used_signatures` — hepsi `rls_enabled: true`.

**`search_path = ''`:** Canlı DB'de doğrudan sorgulandı (`pg_proc.proconfig`). Sonuç — **4 atomic RPC fonksiyonunun hepsinde aktif:**

| Fonksiyon | `proconfig` |
|---|---|
| `update_pixel_owner_atomic` | `search_path=""` |
| `update_board_pixel_owner_atomic` | `search_path=""` |
| `insert_pixels_atomic` | `search_path=""` |
| `insert_board_pixels_atomic` | `search_path=""` |

Hepsi `SECURITY INVOKER` (`prosecdef: false`) — `SECURITY DEFINER` değiller, yani çağıranın (service role) yetkileriyle çalışıyorlar, ayrıca doğru bir varsayılan.

### 2.4 Performans Advisor'ları (bilgi amaçlı)

`get_advisors(type=performance)`: 4 adet "unused index" bulgusu (`idx_board_pixels_banner_group`, `idx_payments_wallet`, `idx_payments_action`, `idx_intents_buyer`) — hepsi INFO seviyesinde. Beklenen: bu tablolarda henüz gerçek trafik yok (`payment_transactions`/`purchase_intents` satır sayısı 0), indeksler henüz kullanılmamış görünüyor çünkü hiç sorgu çalışmamış. Production trafiği başladıktan sonra tekrar kontrol edilmesi yeterli, şimdiden aksiyon gerekmiyor.

### 2.5 Karar noktası: aynı proje mi, yeni proje mi?

| Yol | Artı | Eksi |
|---|---|---|
| **A. Mevcut `Sol-98` projesini production yap** | Migration geçmişi zaten orada, ek iş yok, hemen kullanılabilir | Staging ile production ayrımı yok — ileride ayrı bir staging ortamı isterseniz sıfırdan kurmanız gerekir |
| **B. Yeni, ayrı bir production projesi aç** | Temiz staging/production ayrımı, gelecekteki riskli testler prod veriyi etkilemez | 8 migration'ın hepsinin yeniden uygulanması gerekir (dosyalar hazır, `mcp__Supabase__apply_migration` ile sırayla uygulanabilir); yeni env var seti (yeni URL + yeni service role key) Vercel'e girilmeli |

Öneri: **B** (ayrı production projesi) — özellikle gerçek para/mainnet işlemleri başlayacaksa, staging'de yapılacak gelecekteki testlerin canlı bakiyeleri etkilememesi için. Ama bu tamamen sizin kararınız; A da teknik olarak çalışır durumda.

---

## 3) GÖREV 2 — Production Environment Variables

Aşağıdaki tablo, brief'teki isimler yerine **kodun gerçekte okuduğu değişken adlarını** kullanıyor (`lib/solana.ts`, `lib/server/rpc.ts`, `lib/server/supabase-env.ts` içinde doğrulandı) — önemli bir fark var: **`NEXT_PUBLIC_SUPABASE_URL` diye bir değişken yok ve olmamalı.** Supabase'e sadece server tarafı erişiyor (`SUPABASE_URL`, `NEXT_PUBLIC_` öneki yok, client bundle'a hiç girmiyor) — bu doğru ve güvenli; brief'teki isim muhtemelen genel bir varsayımdı.

### 3.1 Kritik — bunlar olmadan production'da yazma işlemleri 500 döner veya hiç çalışmaz

| Değişken | Ne için | `.env.local` (staging) durumu | Not |
|---|---|---|---|
| `NODE_ENV` | `production` olmalı — `requireDurableStore()` ve `assertMainnetInProduction()` sadece bu değer `production` iken devreye giriyor | Vercel otomatik set eder | Elle set etmeyin, Vercel build'de zaten `production` |
| `SUPABASE_URL` | Durable store (pixels/board/documents/used_signatures/purchase_intents/ledger/audit) | ✅ SET | Production projesine göre güncellenmeli (bkz. §2.5 kararı) |
| `SUPABASE_SERVICE_ROLE_KEY` | Aynı — RLS'yi bypass eden yazma yetkisi | ✅ SET | **Asla client'a/repoya yazılmamalı** — sadece Vercel env var olarak |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | Her satış SOL'unun gittiği cüzdan; boşsa `getTreasuryPublicKey()` hata fırlatır, satın alma tamamen durur | ✅ SET | **Production'a geçmeden önce bunun gerçek, kontrolünüzdeki bir mainnet cüzdanı olduğunu iki kez doğrulayın** — kodda placeholder/system-program adresine karşı da bir kontrol var (`PublicKey.default` reddediliyor) ama yanlış-fakat-geçerli bir adrese karşı koruma yok |

### 3.2 Kritik — mainnet doğrulamasının güvenilirliği için

| Değişken | Ne için | `.env.local` durumu | Not |
|---|---|---|---|
| `SOLANA_RPC_URL` | **Server-only.** API route'larının işlem doğrulaması (`verifySolTransfer`/`verifyBurn`/`verifyTokenTransfer`) ve `assertMainnetInProduction()`'ın genesis-hash kontrolü bunu kullanır; boşsa client'ın kullandığı public endpoint'e (`NEXT_PUBLIC_SOLANA_RPC_URL`, varsayılan Ankr) düşer | ❌ **EMPTY** | **Production'a geçmeden dolduruz önerilir.** `.env.example`'daki not doğru: doğrulama trafiğinin public/paylaşımlı bir endpoint yerine adanmış bir sağlayıcıda (Helius/Triton/QuickNode) olması hem güvenilirlik hem rate-limit riski açısından önemli. Boş bırakılırsa sistem yine çalışır (fallback var) ama public RPC rate-limit'e takılırsa ödemeler doğrulanamayabilir → §5.2'deki "RPC şişmesi" senaryosu tam olarak bu. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Client (cüzdan adaptörü) işlemleri buradan gönderir | ✅ SET | — |

### 3.3 Token — mint edilene kadar bilinçli olarak boş

| Değişken | Ne için | `.env.local` durumu | Not |
|---|---|---|---|
| `NEXT_PUBLIC_PIXEL98_MINT` | Set edilene kadar: hijack "simulated" modda (ücretsiz, imzalı, rate-limited) çalışır; `$PIXEL98` ile ödeme yapılan tüm yollar (`buy-listing`/`rent` PIXEL98 currency, board.exe hijack) `503 "$PIXEL98 not live yet"` döner — kod zaten bunu her yazma yolunda (`app/api/pixels/route.ts`, `app/api/boards/route.ts`) server-side kontrol ediyor, client'ın iddiasına güvenmiyor | ❌ EMPTY (beklenen) | **Token mint edildikten sonra tek yapılması gereken bu değişkeni Vercel'de set edip yeniden deploy etmek** — kod tarafında başka hiçbir değişiklik gerekmiyor, bu tasarımın amacı zaten buydu (Phase 3-4'te "token activation prep") |

### 3.4 Opsiyonel

| Değişken | Ne için | Durum |
|---|---|---|
| `NEXT_PUBLIC_PIXELS_API_URL` | Board state endpoint'i, varsayılan `/api/pixels` | ✅ SET (varsayılanla aynı olabilir) |
| `PIXELS_TABLE` / `DOCUMENTS_TABLE` / `SIGNATURES_TABLE` | Tablo adlarını override etmek için | Set değil — varsayılanlar (`pixels`/`documents`/`used_signatures`) kullanılıyor, sorun değil |

### 3.5 Vercel'e Girilecek Nihai Liste (özet)

Production deploy'dan önce Vercel proje ayarlarında (Production environment) şunlar dolu olmalı:

1. `SUPABASE_URL` — (§2.5 kararına göre production/staging projesinin URL'i)
2. `SUPABASE_SERVICE_ROLE_KEY` — aynı projenin service role key'i
3. `NEXT_PUBLIC_TREASURY_ADDRESS` — gerçek mainnet treasury cüzdanı (iki kez doğrulanmış)
4. `NEXT_PUBLIC_SOLANA_RPC_URL` — mainnet RPC (mevcut değer korunabilir veya adanmış sağlayıcıya yükseltilebilir)
5. `SOLANA_RPC_URL` — **önerilir:** adanmış bir sağlayıcı (Helius/QuickNode), boş bırakılırsa (4)'e düşer
6. `NEXT_PUBLIC_PIXEL98_MINT` — **token mint edilene kadar boş bırakılmalı**, mint edildiğinde doldurulup redeploy edilmeli

---

## 4) GÖREV 3 — $PIXEL98 Mainnet Entegrasyonu İçin Kod Seviyesi Hazırlık Durumu

Kod tarafında token aktivasyonu için **ek geliştirme gerekmiyor** — tasarım zaten "mint adresi env var'dan gelene kadar özellik kapalı" prensibiyle kurulmuş (Phase 3-4). Doğrulanan noktalar:

- `lib/solana.ts` → `isTokenLive()` = `PIXEL98_MINT.length > 0`, tek gerçek kaynak.
- Her ödeme yolu server-side ayrıca kontrol ediyor (`if (!PIXEL98_MINT) return fail(503, ...)`), yani client tarafı manipüle edilse bile mint boşken $PIXEL98 ödemesi kabul edilmiyor.
- `lib/server/token-stats.ts` mint set edildiğinde `getMint()` ile on-chain arz bilgisini okuyor; mint boşken `0` dönüyor (whitepaper/istatistik sayfası kırılmıyor).
- Hijack'in "simulated" (mint yokken) ve "gerçek" (mint varken) modları arasındaki geçiş tamamen bu tek değişkenle kontrol ediliyor — `components/pixel-dialog.tsx`/`components/start-ads.tsx` her ikisini de zaten destekliyor (Phase 4'te test edildi).

**Mint edildikten sonra yapılacak TEK adım:** `NEXT_PUBLIC_PIXEL98_MINT` değerini Vercel production env'e girip redeploy etmek. Sonrasında §5'teki smoke test planındaki $PIXEL98 adımı çalıştırılmalı.

---

## 5) Smoke Test Planı — Canlıya Aldıktan Sonraki İlk 1 Saat

Sıra önemli: her adım bir öncekinin başarılı olduğunu doğruladıktan sonra çalıştırılmalı. Her adımda **gerçek ama küçük tutarlar** kullanın (aşağıda önerilen miktarlar).

### 5.1 Adım Adım Plan

**T+0 dk — Deploy sonrası temel sağlık kontrolü**
1. Vercel deploy loglarında build hatasız tamamlanmış mı kontrol edin.
2. `GET /api/pixels` (veya UI'da board yüklensin) — 200 dönüyor mu, mevcut pixel verisi görünüyor mu.
3. `assertMainnetInProduction()` bir ilk istekte sessizce geçmeli (hata fırlatmıyorsa RPC gerçekten mainnet-beta'dır — genesis hash eşleşti). Eğer herhangi bir ödeme isteği `"refusing to verify payments: server RPC is not mainnet-beta"` hatasıyla 500 dönerse **hemen durun** — bkz. §5.2 senaryo 1.

**T+5 dk — 1 adet Treasury (Hazine) alımı — küçük bakiyeyle**
4. UI üzerinden **tek bir boş pixel** satın alın (SOL ile), kendi test cüzdanınızdan, minimum fiyatta.
5. Doğrulayın: (a) transaction mainnet'te confirmed, (b) pixel UI'da yeni sahibiyle görünüyor, (c) Supabase'de `payment_transactions` tablosuna satır düştü, (d) `pixel_ownership_history`'ye satır düştü, (e) `pixels` tablosundaki satır güncel sahiple eşleşiyor. Bu, `insert_pixels_atomic` RPC'sinin canlıda ilk gerçek çağrısı — atomiklik burada kanıtlanıyor (ownership + ledger tek transaction'da).

**T+15 dk — 1 adet P2P Purchase Intent testi (listing satışı)**
6. Adım 4'te satın aldığınız pixel'i **listeye koyun** (satışa çıkarın), küçük bir fiyatla.
7. **İkinci bir test cüzdanından** o listeyi satın alın: intent oluşturma (`POST /api/purchase-intents`) → ödeme → redemption tam akışını uçtan uca çalıştırın.
8. Doğrulayın: intent `consumed` durumuna geçti, `update_pixel_owner_atomic` çağrıldı, yeni sahip doğru, eski sahibin cüzdanına SOL gitti (P2P — treasury'ye değil).

**T+25 dk — Cüzdan imza doğrulaması (red-team senaryosu)**
9. Bilerek **yanlış bir cüzdanla** (intent'i açan cüzdan değil) aynı intent'i redeem etmeyi deneyin → `403` beklenmeli (Phase 4'te test edilen "foreign wallet" senaryosu).
10. Bir intent'i **süresi dolana kadar bekletip** (veya TTL'i kısa bir test intent'iyle) redeem etmeyi deneyin → `410` beklenmeli.
11. Her iki durumda da: hiçbir DB değişikliği olmamalı (pixel sahibi değişmemiş, ledger'a satır düşmemiş) — bu, "clean rejection, no partial state" garantisinin canlıda da geçerli olduğunu kanıtlar.

**T+40 dk — (Token mint edildiyse) $PIXEL98 smoke test**
12. Sadece `NEXT_PUBLIC_PIXEL98_MINT` set edilmişse: küçük bir hijack işlemini gerçek token ile deneyin, burn+split'in on-chain doğrulandığını (`verifyBurn`) ve `payment_transactions`'a doğru `mint` değeriyle düştüğünü kontrol edin.

**T+55 dk — Kapanış kontrolü**
13. `get_advisors` (security + performance) tekrar çalıştırın — smoke test trafiğinin yeni bir güvenlik bulgusu açmadığını doğrulayın.
14. Treasury cüzdanının bakiyesinin adım 4'teki satış kadar arttığını (block explorer'dan) doğrulayın.

### 5.2 Olası Hata Senaryoları ve Acil Durum Adımları

**Senaryo 1 — RPC mainnet doğrulaması başarısız / "RPC şişmesi" (rate limit, timeout)**
- Belirti: ödeme isteği yolları 500 ile `"refusing to verify payments..."` veya genel bir RPC timeout hatası dönüyor.
- Acil aksiyon: **satın alma akışını durdurmayın demeyin — zaten kendiliğinden durur** (fail-closed tasarım, `assertMainnetInProduction` her zaman `production`'da çalışır). Yapılacak: `SOLANA_RPC_URL`'i adanmış bir sağlayıcıya (Helius/QuickNode) çevirip redeploy edin. Bu tek başına kodda hiçbir değişiklik gerektirmez, sadece env var.
- Rollback gerekmiyor — sistem zaten hiçbir yanlış ödemeyi kabul etmemiş olur (bu senaryonun bütün amacı bu).

**Senaryo 2 — `unique_violation` (aynı pixel'e çift satış denemesi, race condition)**
- Belirti: `insert_pixels_atomic`/`update_pixel_owner_atomic` `{ok: false, reason: "..."}` dönüyor (exception olarak değil — bu beklenen, "temiz reddediliş" yolu).
- Acil aksiyon: **Hiçbir şey yapmayın** — bu, atomik RPC'lerin tam olarak önlemek için tasarlandığı senaryo. Kaybeden taraf UI'da "bu pixel az önce satıldı" tarzı bir hata görür, parası gitmemiştir (ödeme doğrulaması RPC'den önce yapılıyor ama RPC `ok:false` dönerse route handler ödemeyi treasury'ye/satıcıya geri iade etmez otomatik — **bu bir gap**: eğer kullanıcı gerçekten SOL gönderdiyse ama RPC race'i kaybettiyse, elle iade gerekebilir. Destek talebi gelirse: ilgili `signature`'ı `payment_transactions`'ta arayın, `insert_pixels_atomic`'in o istek için `ok:false` döndüğünü doğrulayın, ve kullanıcıya elle SOL iadesi yapın.
- Not: ledger INSERT'i (audit trail) `unique_violation` DIŞINDA bir hatayla karşılaşırsa (örn. beklenmeyen bir constraint/tip hatası) bu exception olarak fırlatılır ve **tüm transaction rollback olur** (ownership da geri alınır) — yani gerçek bir anomali hiçbir zaman yarım durumda kalmaz. Bu durumda Supabase log'larına (`mcp__Supabase__query_logs` veya dashboard) bakıp hatanın kaynağını (muhtemelen şema/tip uyuşmazlığı) tespit edin.

**Senaryo 3 — Treasury adresi yanlış girilmiş (yanlış cüzdan)**
- Belirti: smoke test adım 4'te ödeme "doğrulandı" görünüyor ama block explorer'da SOL beklenen cüzdana gitmemiş.
- Acil aksiyon: **Deploy'u derhal durdurun / eski deploy'a geri alın** (Vercel "Instant Rollback"), `NEXT_PUBLIC_TREASURY_ADDRESS`'i düzeltip yeniden deploy edin. Bu adım tamamlanana kadar kullanıcıların satın alma yapmasına izin vermeyin (bakım moduna alın ya da satın alma butonlarını geçici devre dışı bırakın).
- Not: kod `PublicKey.default` (system program) adresine karşı zaten koruyor — ama *yanlış ama geçerli* bir adrese karşı bir koruma yok, bu yüzden bu adım manuel doğrulamaya dayanıyor (§3.1'de de belirtildi).

**Senaryo 4 — `$PIXEL98` mint set edildi ama `verifyBurn` sürekli başarısız oluyor**
- Belirti: hijack işlemleri gerçek token modunda tutarlı biçimde reddediliyor.
- Acil aksiyon: `NEXT_PUBLIC_PIXEL98_MINT` değerinin Pump.fun'daki gerçek mint adresiyle birebir eşleştiğini doğrulayın (yanlış/eski bir adres en olası sebep). Doğruysa, `lib/server/token-stats.ts`'in `getMint()` çağrısının döndüğü decimals değeriyle `tokenAmountToRaw()`'ın hesapladığı raw miktarı karşılaştırın — decimals uyuşmazlığı ikinci en olası sebep. Düzeltilene kadar mint'i tekrar boşaltıp (`NEXT_PUBLIC_PIXEL98_MINT=`) redeploy ederek hijack'i simulated moda geri döndürebilirsiniz — bu, kullanıcı için "geçici olarak ücretsiz mod" anlamına gelir ama sistemi tamamen kapatmaktan daha güvenlidir ve tek satır env var değişikliği.

**Genel kural:** Bu sistemde "kısmi başarı" state'i mimari olarak neredeyse imkansız kılınmış (atomic RPC'ler + fail-closed gate'ler) — bu yüzden çoğu hata senaryosunda gerçek "rollback" (veri geri alma) değil, **env var düzeltip redeploy** yeterli oluyor. Gerçek bir veri rollback'i gereken tek durum Senaryo 3 (yanlış treasury) gibi, koddan değil insan hatasından kaynaklanan senaryolardır.

---

## 6) Kontrol Listesi (Vercel'e Basmadan Önce)

- [ ] §2.5 kararı verildi: aynı proje mi (A) yoksa yeni production projesi mi (B)?
- [ ] (B seçildiyse) 8 migration yeni projeye sırayla uygulandı, `get_advisors` temiz
- [ ] `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` Vercel production env'e girildi
- [ ] `NEXT_PUBLIC_TREASURY_ADDRESS` girildi VE elle iki kez doğrulandı (gerçek, kontrolünüzdeki mainnet cüzdanı)
- [ ] `NEXT_PUBLIC_SOLANA_RPC_URL` mainnet'e işaret ediyor
- [ ] `SOLANA_RPC_URL` adanmış bir sağlayıcıya set edildi (önerilir, zorunlu değil)
- [ ] `NEXT_PUBLIC_PIXEL98_MINT` — token henüz mint edilmediyse **bilerek boş bırakıldı**
- [ ] İlk deploy sonrası §5.1'deki smoke test planı sırayla çalıştırıldı
- [ ] Smoke test sonrası `get_advisors` (security + performance) tekrar çalıştırıldı

---

*Bu doküman SOL-98 Phase 5 kapsamında, canlı Supabase projesine (`hjziuadsnlofgarjsawy`) karşı gerçek sorgularla (`list_migrations`, `get_advisors`, `execute_sql`, `list_tables`) ve repodaki gerçek kod/env dosyalarının incelenmesiyle hazırlanmıştır. Hiçbir secret değeri bu dosyaya yazılmamıştır.*
