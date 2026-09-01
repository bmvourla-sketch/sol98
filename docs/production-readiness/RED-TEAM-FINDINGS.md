# SOL-98 — Kırmızı Takım (Red-Team) Bulguları

Bu doküman, sistemin tamamına (API route'ları, atomic RPC'ler, client store'lar, migration'lar) düşmanca bir gözle yapılan manuel kod incelemesinin ve canlı Supabase projesine (`hjziuadsnlofgarjsawy`) karşı yapılan gerçek sorguların sonucudur. Otomatik bir tarayıcı değil, gerçek kod okunarak, "bunu nasıl kırarım" sorusuyla yürütülmüştür. Hiçbir prod veri bozulmamış, sadece salt-okunur doğrulama sorguları çalıştırılmıştır.

**Önem sırasına göre 7 bulgu var — 1 tanesi gerçek, önceden bilinmeyen bir ekonomik istismar (HIGH), 2 tanesi önceki fazlarda kapatılan bir güvenlik açığı sınıfının unutulmuş bir köşesi (MEDIUM), geri kalanı bilgi/iyileştirme amaçlı.**

---

## BULGU 1 (HIGH) — Bonding-curve fiyat yarışı: eşzamanlı isteklerle ucuza toplu alım

**Nerede:** `app/api/pixels/route.ts` → `handleBuy` / `handleBuyArea`, `app/api/boards/route.ts` → `handleBuyBoard`

**Ne oluyor:** Her üç treasury-satın-alma yolu da fiyatı şöyle hesaplıyor:
```
const currentSoldCount = await soldCount();       // canlı, kilitsiz bir COUNT sorgusu
const priceSol = nextSpotPrice(currentSoldCount);  // bonding curve fiyatı
```
`soldCount()` (`lib/server/pixel-db-supabase.ts`) PostgREST'e `Prefer: count=exact` ile atılan basit bir GET — **hiçbir satır kilitlemiyor, hiçbir transaction'a bağlı değil.** Fiyat hesaplandıktan SONRA ödeme doğrulanıyor ve ancak ondan sonra `insertPixelsAtomic`/`insertBoardAtomic` RPC'si çağrılıyor — ama bu RPC'ler (bkz. `supabase/migrations/0005_treasury_purchase_atomicity.up.sql`) fiyatı bir daha hiç kontrol etmiyor, JS tarafında zaten hesaplanmış `amount_sol`'u olduğu gibi ledger'a yazıyor.

Kodun kendi yorumları bunu zaten örtük olarak kabul ediyor: `lib/server/mutex.ts` — *"This does NOT span multiple serverless instances"* — ve `lib/server/rate-limit.ts` aynı şeyi söylüyor. Yani `withWriteLock` sadece TEK bir Node process'i içinde sıralıyor; Vercel'de eşzamanlı gelen istekler farklı instance'larda paralel çalışırsa bu kilit hiçbir şeyi senkronize etmiyor — ki bu, gerçek üretim trafiğinin tam olarak beklenen şeklidir.

**Somut saldırı senaryosu:** Saldırgan önceden N adet gerçek ama düşük değerli (mevcut `soldCount`'a göre hesaplanmış, düşük) transfer'i treasury'ye gönderip mainnet'te confirm olmalarını bekler. Sonra N farklı boş index için `buy` isteğini **eşzamanlı** (aynı anda, paralel HTTP) API'ye atar. Her istek kendi `soldCount()` okumasını yapar; eğer hepsi diğerlerinin henüz commit olmamış INSERT'lerinden ÖNCE okursa, hepsi AYNI (düşük) fiyatı hesaplar ve saldırganın önceden gönderdiği düşük ödemeler hepsini geçer. Sonuç: bonding curve'ün amaçladığı artan-fiyat mekanizması atlanmış olur — saldırgan çok sayıda spotu, sıralı alsaydı ödeyeceğinden çok daha ucuza toplar. `buy-area` (tek çağrıda çoklu blok) zaten kendi içinde `soldCount`'u sabit tutup doğru merdiven fiyatı uyguluyor — sorun SADECE ayrı ayrı çağrılar arasında.

**Neden `insert_pixels_atomic` bunu kapatmıyor:** RPC sadece INSERT'in kendisini (aynı index'e çifte satış) atomikleştiriyor — `pixels.index` primary key olduğu için iki request AYNI index'i alamaz. Ama FARKLI index'ler için fiyatın DOĞRU (o anki gerçek soldCount'a göre) olup olmadığını RPC hiç bilmiyor/kontrol etmiyor, çünkü fiyat zaten JS'te, RPC çağrılmadan önce sabitlenmiş oluyor.

**Önerilen düzeltme:** Sayım ve fiyat kararını AYNI transaction içine, INSERT ile birlikte taşıyın — örn. RPC'ye önceden hesaplanmış `amount_sol` yerine sadece `count` gönderin ve RPC içinde `select count(*) from pixels for update` (ya da ayrı bir atomic sequence/counter satırı) ile fiyatı kendisi hesaplayıp, ödeme doğrulamasını da (ya da en azından bir min/max fiyat toleransını) o anki gerçek sayıma göre server-side yeniden değerlendirsin. Alternatif, daha basit bir ara çözüm: `buy`/`buy-board` için de `withWriteLock` yerine (ya da onunla birlikte) tek satırlık bir Postgres advisory lock (`pg_advisory_xact_lock`) kullanmak — bu, cross-instance çalışır çünkü kilit veritabanında tutulur, process'te değil.

---

## BULGU 2 (MEDIUM) — Documents satın alma yolu hiç atomic hale getirilmemiş (P2-F4'ün unutulmuş köşesi)

**Nerede:** `app/api/documents/route.ts`

**Ne oluyor:** Phase 3/4'te pixel ve board.exe satın almaları için "ownership + ledger tek transaction'da" (P2-F4 bulgusunun düzeltmesi) yapıldı — ama `documents/route.ts` bu geçişten HİÇ geçmedi. Hâlâ eski desende:
```ts
const created = await createDocument(doc);                          // 1. yazı
await recordPaymentTransaction({ signature, wallet: actor, ... });   // 2. AYRI yazı — best-effort, ASLA throw etmez
```
`recordPaymentTransaction` (`lib/server/payment-ledger.ts`) kasıtlı olarak best-effort — kendi içindeki `catch` bloğu her hatayı yutuyor, sadece `logAudit` ile loglayıp sessizce dönüyor. Yani: `createDocument` başarılı olur olmaz doküman zaten teslim edilmiştir; hemen ardından gelen `recordPaymentTransaction` ağ hatası/geçici Supabase kesintisi yüzünden sessizce başarısız olursa, **gerçek, parası ödenmiş bir satışın `payment_transactions` tablosunda hiçbir izi kalmaz.** Muhasebe/denetim açısından sessiz bir boşluk — tam olarak Phase 3'ün "P2-F4: ledger completeness" bulgusunun tanımladığı sorun sınıfı, sadece bu rotaya hiç uygulanmamış.

**Önerilen düzeltme:** `documents` için de aynı desen: `createDocument` + `payment_transactions` INSERT'ini tek bir plpgsql RPC'ye (`insert_document_atomic` gibi) taşıyın — `insert_pixels_atomic` ile birebir aynı iskelet kullanılabilir.

---

## BULGU 3 (MEDIUM) — `purchase_intents` asla süresi dolmuş/iptal olarak işaretlenmiyor — sınırsız büyüyen tablo

**Nerede:** `lib/server/intent-db.ts` (tip tanımı), şema (`0004_purchase_intents_and_atomicity.up.sql`)

**Ne oluyor:** `IntentStatus` tipi ve DB `check` kısıtı `'expired'` ve `'cancelled'` durumlarını tanımlıyor, ama repo'nun tamamında bu iki değeri gerçekten YAZAN tek bir kod yolu yok (`grep` ile doğrulandı — sıfır eşleşme). Süresi dolan bir intent sadece redemption anında `expiresAt <= Date.now()` kontrolüyle **işlevsel olarak** reddediliyor; DB'deki satırın `status` kolonu sonsuza kadar `'pending'` kalıyor. Ne bir "cancel" endpoint'i var, ne de süresi dolanları temizleyen bir cron/reaper job. Canlı projede şu an `purchase_intents` boş (`select status, count(*) ... group by status` → 0 satır, henüz gerçek trafik yok) ama üretimde her yarım kalan/vazgeçilen "satın al" denemesi kalıcı bir `pending` satırı bırakacak — tablo sınırsız büyür. Bu aynı zamanda Phase 5 raporunda "unused index" olarak işaretlenen `idx_intents_buyer` bulgusunu da kısmen açıklıyor: status'a göre gerçek bir sorgu/temizlik hiç çalışmadığı için o indeks fiilen hiç kullanılmıyor.

**Önerilen düzeltme:** Basit bir periyodik iş (Supabase `pg_cron` ya da Vercel cron route) ekleyin: `update purchase_intents set status='expired' where status='pending' and expires_at < now()`. Kritik değil ama üretim öncesi eklenmesi önerilir — aksi halde tablo zamanla hem şişer hem de "status" alanı hiçbir zaman gerçeği yansıtmaz.

---

## BULGU 4 (LOW/INFO) — Rate-limit ve mutex zaten dokümante edilmiş sınırlar + `X-Forwarded-For` sahtekarlığı

`lib/server/rate-limit.ts` ve `lib/server/mutex.ts` ikisi de kod içi yorumlarında dürüstçe belirtiyor: process-içi, serverless instance'lar arasında paylaşılmıyor. Buna ek, gözden kaçan bir nokta: `requestIp()` (`rate-limit.ts`) `x-forwarded-for` header'ının İLK değerini doğrudan güveniyor:
```ts
const forwarded = request.headers.get("x-forwarded-for");
if (forwarded) return forwarded.split(",")[0].trim();
```
Eğer bu header Vercel edge katmanı tarafından garanti altına alınmıyorsa (ör. origin'e doğrudan erişim mümkünse, ya da hosting bu header'ı sanitize etmiyorsa), bir saldırgan her istekte farklı bir `X-Forwarded-For` değeri göndererek kendi IP-bazlı rate-limit bucket'ını trivial şekilde sıfırlayabilir. Rate limit zaten "casual script'lere karşı bar yükseltme" olarak belgelenmiş, tek başına güvenlik sınırı değil — ama üretime geçmeden Vercel'in bu header'ı gerçekten güvenilir şekilde set ettiğini (ve müşteri isteğindeki değeri override ettiğini) doğrulamak önerilir.

---

## BULGU 5 (LOW) — Treasury adresi: yanlış-ama-geçerli bir adrese karşı koruma yok

(Phase 5 raporunda da not edilmişti, red-team bağlamında tekrar teyit edildi.) `lib/solana.ts`'deki `getTreasuryPublicKey()` sadece `PublicKey.default` (system program placeholder) adresine karşı koruyor. `NEXT_PUBLIC_TREASURY_ADDRESS` production'a YANLIŞ AMA GEÇERLİ bir cüzdanla girilirse (kopyala-yapıştır hatası, yanlış cüzdan), kod bunu tespit edemez — her satış o yanlış adrese gider ve `verifySolTransfer` de mutlu bir şekilde doğrular (zaten "doğru" adres olarak onu görüyor). Tek savunma insan doğrulaması (bkz. Phase 5 §3.1 ve §5.2 senaryo 3).

---

## BULGU 6 (INFO) — İmzalı ücretsiz-aksiyon mesajlarında tek-kullanımlık koruma yok

`lib/server/verify-message.ts` → `verifyAuthProof`, `edit`/`list-sale`/`list-rent`/`unlist` ve pre-launch simulated `hijack` için kullanılan imzalı mesajları sadece bir **zaman penceresi** (`AUTH_MESSAGE_MAX_AGE_MS = 5 dakika`) ile doğruluyor — ödeme akışındaki `used_signatures` gibi bir "bu imza daha önce kullanıldı mı" tek-kullanımlık defteri yok. Yakalanmış (ör. ağ trafiği izlenerek) geçerli bir imza, 5 dakikalık pencere içinde AYNI aksiyon için tekrar gönderilebilir. Etki düşük — bu aksiyonlar parasız ve idempotent (aynı ilanı aynı fiyata tekrar listelemek, aynı reklamı tekrar kaydetmek zarar vermez) ve zaten rate-limit'e tabi — ama ödeme tarafındaki tek-kullanımlık disiplinle simetrik değil, bilinçli bir tasarım kararı olarak belgelenmemiş bir asimetri.

---

## BULGU 7 (INFO) — `data:image/svg+xml` kabul ediliyor — savunma derinliği notu

`lib/pixel-types.ts` → `isSafeImageUrl`, `data:image/svg+xml;base64,...` data URI'lerini kabul ediyor. Şu an bu değer sadece `<img src=...>` ve CSS `.style.backgroundImage = ...` (bir CSSOM property ataması, string enjeksiyonuna kapalı) olarak render ediliyor — bu bağlamlarda gömülü `<script>`/olay-işleyicileri modern tarayıcılarda çalışmaz, yani BUGÜN aktif olarak sömürülebilir değil. Ama SVG'nin script çalıştırabilen tek format olması nedeniyle ("open image in new tab" gibi ileride eklenebilecek bir özellik, ya da sosyal-medya-önizleme server-side render'ı gibi) gelecekteki bir render yolunda risk taşıyor. Öneri: kabul edilen `data:image/*` listesinden `svg+xml`'i çıkarıp yalnızca raster formatlara (`png`/`jpe?g`/`gif`/`webp`) izin vermek — reklam içeriği tam olarak "başka bağlamlara kopyalanabilecek" türden bir içerik.

---

## Özet Tablo

| # | Bulgu | Önem | Etki türü |
|---|---|---|---|
| 1 | Bonding-curve fiyat yarışı (buy/buy-area/buy-board) | **HIGH** | Ekonomik istismar — düşük fiyata toplu alım |
| 2 | Documents satın alma atomic değil | **MEDIUM** | Sessiz muhasebe/denetim boşluğu |
| 3 | Intent'ler asla expired/cancelled işaretlenmiyor | **MEDIUM** | Sınırsız tablo büyümesi, yanıltıcı status alanı |
| 4 | Rate-limit + X-Forwarded-For güveni | LOW/INFO | Rate-limit atlatma (zaten belgeli sınırın ötesinde) |
| 5 | Treasury adresi insan-hatasına karşı korumasız | LOW | Operasyonel risk (zaten Phase 5'te not edildi) |
| 6 | Ücretsiz aksiyon imzalarında tek-kullanım yok | INFO | Düşük etkili replay (idempotent aksiyonlar) |
| 7 | `svg+xml` data URI kabulü | INFO | Savunma derinliği, bugün aktif sömürülebilir değil |

**Doğrulanmadı / bilerek dışarıda bırakılan alanlar (kapsam notu):** cüzdan-tarafı (`lib/use-solana-tx.ts`, `components/*`) UI mantığı sadece "server zaten her şeyi yeniden doğruluyor mu" açısından örneklendi, satır satır incelenmedi — çünkü mimari zaten client'a hiç güvenmiyor (her ödeme/imza server-side yeniden doğrulanıyor). Yük/performans testi (gerçek eşzamanlı trafik simülasyonu) yapılmadı — Bulgu 1 kod okumasıyla ve migration/mutex'in kendi yorumlarıyla kanıtlanmış bir yarış deseni, ama canlıda gerçek bir eşzamanlı saldırı denemesi yürütülmedi (staging'e zarar vermemek için).

*Bu doküman, canlı Supabase projesine (`hjziuadsnlofgarjsawy`) karşı çalıştırılan salt-okunur doğrulama sorguları ve repodaki gerçek kod incelenerek hazırlanmıştır. Hiçbir dosya değiştirilmedi, hiçbir prod veri yazılmadı/silinmedi.*
