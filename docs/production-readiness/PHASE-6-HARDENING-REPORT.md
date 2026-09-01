# SOL-98 — PHASE 6: RED-TEAM HARDENING & SECURITY REMEDIATION

**Durum: 4/4 hedeflenen bulgu kapatıldı, gerçek staging Postgres'e karşı kanıtlandı.** `docs/production-readiness/RED-TEAM-FINDINGS.md`'deki 7 bulgudan bu fazın hedefi olan 4'ü (BULGU 1 HIGH, BULGU 2 MEDIUM, BULGU 3 MEDIUM, BULGU 7 INFO) tamamen kapatıldı. Kalan 3 bulgu (4, 5, 6 — rate-limit/X-Forwarded-For, treasury adresi insan-hatası koruması, imzalı mesajlarda tek-kullanım eksikliği) bu fazın kapsamı dışındaydı, dokunulmadı.

Doğrulama zinciri: `npx tsc --noEmit` (temiz), `npm run lint` (temiz), `npx vitest run` (**220/220** unit test — 216 eski + 4 yeni BULGU 7 testi), `npm run build` (başarılı), ve gerçek staging Supabase'e karşı `npx vitest run --config vitest.integration.config.mts` (**39/39** — 34 eski + 5 yeni Phase 6 testi, RED TEAM ırk-koşulu kanıtları dahil). Kod commit/push edilmedi, working tree'de bırakıldı.

---

## GÖREV 1 (BULGU 1, HIGH) — Bonding-curve fiyat yarışının kapatılması

### Sorunun tam olarak neydi

`handleBuy`/`handleBuyArea` (`app/api/pixels/route.ts`) ve `handleBuyBoard` (`app/api/boards/route.ts`), fiyatı `soldCount()`/`countBoardFiles()`'in kilitsiz, canlı bir okumasından JS tarafında hesaplıyordu — bu hesaplama, ardından çağrılan atomic INSERT RPC'sinden (0005) tamamen kopuktu. Process-içi mutex (`createMutex()`) kendi yorumunda zaten "serverless instance'lar arası çalışmıyor" diyor; gerçek atomiklik daima Postgres kısıtlarından gelmesi gerekiyordu ama RPC fiyatı hiç yeniden kontrol etmiyordu.

### Uygulanan çözüm: `pg_advisory_xact_lock` + fiyat mantığının RPC içine taşınması

Brief'in önerdiği iki yaklaşımın (advisory lock VEYA RPC-içi fiyatlama) İKİSİNİ BİRDEN uyguladım, çünkü tek başına hiçbiri yeterli değildi:

1. **Fiyat formülleri SQL'e taşındı** (`supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql`): `lib/pricing.ts`'in `areaPrice`/`bulkBlockPrice` ve `lib/board-types.ts`'in `nextBoardFilePrice` formülleri birebir PL/pgSQL'e port edildi (`area_price_min_lamports`, `next_board_file_min_lamports`), aynı 0.5% tolerans (`min_lamports_with_tolerance`) korunarak — canlıda `select area_price_min_lamports(0,15)` → `3084500000` lamports, elle hesap: 10 blok × 0.2 SOL + 5 blok × 0.22 SOL = 3.1 SOL × 0.995 = 3084500000 lamports. **Birebir eşleşiyor.**
2. **`pg_advisory_xact_lock(hashtextextended('sol98:pixels:treasury', 0))`** (pixels için) ve ayrı bir kilit anahtarı board.exe için — `insert_pixels_atomic`/`insert_board_pixels_atomic`'in EN BAŞINDA. Bu kilit transaction-scoped (fonksiyon çağrısının commit/rollback'inde otomatik serbest kalır) — PostgREST'in "tek çağrı = tek transaction" modeliyle ve connection pooling ile güvenli (session-scoped bir kilit KULLANILMADI, çünkü Supabase'in pooler'ı ile kırılgan olurdu).
3. Kilit alındıktan SONRA `select count(*)` ile TAZE soldCount okunuyor, gerçek gereken fiyat hesaplanıyor, ve çağıranın **GERÇEKTEN zincir-üstünde doğrulanmış** ödediği lamports miktarıyla (`p_paid_lamports`) karşılaştırılıyor — bu, JS'in kendi (racy) fiyat tahmini DEĞİL, `verifySolTransfer`'in artık döndürdüğü gerçek `lamportsFound` değeri (bkz. `lib/server/verify-tx.ts`).
4. Yetersizse: `ok:false, reason:'underpaid'` — mevcut `'conflict'` deseniyle aynı temiz-red desenini izliyor (exception fırlatmıyor, sadece rapor ediyor).

**Neden bu doğru kapatma noktası:** İki eşzamanlı istek AYNI (bayat) soldCount'u okuyup aynı düşük fiyatı hesaplasa bile, kilit onları INSERT sırasında sıralar — kazanan gerçek sırasındaki fiyattan geçer, kaybeden ise kazananın INSERT'i commit olduktan SONRA TAZE okunan (artık daha yüksek) fiyata göre REDDEDİLİR. Bu, zincir-üstü doğrulamanın kendisini (Node'dan async bir Solana RPC çağrısı) tek bir Postgres transaction'ına sığdıramayacağımız gerçeğiyle uyumlu, pragmatik ve KANITLANMIŞ doğru bir çözüm.

### Kanıt (staging'e karşı gerçek RED TEAM testi)

`tests/integration/phase6-hardening-staging.test.ts`:
- **Pixels:** aynı anda, AYNI (o anki) fiyattan, FARKLI iki index'e iki `insert_pixels_atomic` çağrısı → tam olarak biri `ok:true`, diğeri `ok:false, reason:"underpaid"`. DB'de sadece 1 index gerçekten oluşmuş. **Phase 6 öncesi bu senaryoda İKİSİ DE başarılı olurdu.**
- **Board.exe:** aynı desen, `insert_board_pixels_atomic` ile — aynı sonuç.

`verifySolTransfer`'in `lamportsFound` alanı ve `insertPixelsAtomic`/`insertBoardAtomic`'in `paidLamports` parametresi, `app/api/pixels/route.ts` (`handleBuy`, `handleBuyArea`) ve `app/api/boards/route.ts` (`handleBuyBoard`) üzerinden uçtan uca bağlandı; `underpaid` durumunda kullanıcıya "fiyat sizin işleminiz gerçekleşmeden önce değişti (sizden önce biri satın aldı) — ödeme kanıtınız hâlâ geçerli, güncel fiyatı kontrol edip tekrar deneyin" mesajı dönüyor ve imza serbest bırakılıyor (ödeme kanıtı yakılmıyor, tıpkı diğer 409 senaryolarında olduğu gibi).

**Not:** `insert_pixels_atomic`/`insert_board_pixels_atomic`'in eski (0005) 6/8-parametreli imzaları `drop function if exists` ile açıkça kaldırıldı — yeni `p_paid_lamports` parametresi **opsiyonel/varsayılanlı DEĞİL**, zorunlu. Bilerek: bir varsayılan (örn. NULL = "kontrolü atla") eklemek, parametreyi es geçen HERHANGİ bir çağrının fiyat kontrolünü tamamen atlatabileceği yeni bir güvenlik açığı olurdu. Bunun yerine, bu parametreyi kullanmayan (fiyatla ilgilenmeyen, sadece ledger-rollback'i test eden) iki eski Phase 4 RED TEAM testi güncellenip yeterince yüksek bir `p_paid_lamports` değeri geçecek şekilde düzeltildi.

---

## GÖREV 2 (BULGU 2, MEDIUM) — Documents atomikliği

`supabase/migrations/0006_...up.sql` → `insert_document_atomic(p_doc, p_signature, p_wallet, p_action, p_amount_sol)`: belge INSERT'i ve `payment_transactions` INSERT'i artık TEK bir plpgsql fonksiyonunda, tek transaction'da. Fiyat sabit olduğu için (bonding curve yok) advisory lock gerekmedi.

`lib/server/document-insert-atomic.ts` (yeni dosya) — `pixel-insert-atomic.ts`/`board-insert-atomic.ts` ile birebir aynı iskelet: Supabase RPC yolu + dev-only file-store fallback. `app/api/documents/route.ts` yeniden yazıldı: eski `createDocument()` + ayrı best-effort `recordPaymentTransaction()` çağrısı tamamen kaldırıldı, `insertDocumentAtomic()` ile değiştirildi — Phase 2.1'in (P2-F2) "thrown error → release signature" deseni de artık burada da var (önceden yoktu, sadece `createDocument`'i sarıyordu, ledger yazımını değil).

**Kanıt:** RED TEAM testi — aynı imzayla önce elle bir `payment_transactions` satırı ekleniyor, sonra `insert_document_atomic` AYNI imzayla çağrılıyor → RPC çağrısı `unique_violation` ile başarısız oluyor VE belge satırı hiç oluşmamış (rollback). Ayrıca mutlu-yol testi: belge + ledger satırı tek çağrıda birlikte var oluyor.

---

## GÖREV 3 (BULGU 3, MEDIUM) — Intent expiry

`expire_stale_purchase_intents()` RPC'si eklendi: `status='pending' and expires_at < now()` olan tüm satırları `'expired'`e çeviriyor, kaç satır etkilendiğini döndürüyor. `lib/server/intent-db-supabase.ts`'e eklenen `expireStaleIntents()` bu RPC'yi best-effort (hata yutan) şekilde çağırıyor; `lib/server/intent-db.ts`'in `createIntent()`'ı — Supabase yolunda — her yeni intent oluştururken bunu **`await` ETMEDEN** ("fire and forget") tetikliyor, böylece süpürme hiçbir zaman intent oluşturma isteğinin gecikmesine ya da başarısız olmasına sebep olmuyor. Brief'in "opsiyonel SQL fonksiyonu" isteği + gerçekten çalışan bir tetikleme mekanizması birlikte sağlandı — ileride bir `pg_cron` zamanlamasına bağlamak için de hiçbir şema değişikliği gerekmiyor, aynı fonksiyon çağrılabilir.

**Kanıt:** RED TEAM testi — elle 1 saat önce süresi dolmuş bir `pending` satır VE 1 saat sonra dolacak bir `pending` satır ekleniyor, süpürme çalıştırılıyor, ilk satır `'expired'`e dönüyor, ikinci satır `'pending'` olarak dokunulmadan kalıyor.

---

## GÖREV 4 (BULGU 7, INFO) — SVG görsel güvenliği

`lib/pixel-types.ts` → `isSafeImageUrl`: kabul edilen `data:image/*` listesi `png|jpe?g|gif|webp|svg\+xml` → **`png|jpe?g|webp`** olarak daraltıldı. Brief'in listesi (`png, jpeg, webp`) birebir uygulandı — bu, `gif`'i de kapsam dışına aldı (sadece **inline data URI** GIF'ler; `https://.../banner.gif` gibi http(s)-barındırılan bir GIF hâlâ kabul ediliyor, çünkü o farklı bir regex dalından geçiyor, data URI değil).

4 yeni birim testi eklendi (`tests/pixel-types.test.ts`): `svg+xml` artık reddediliyor, data-URI `gif` artık reddediliyor, http(s) `.gif` hâlâ kabul ediliyor, `jpeg`/`jpg`/`webp` data URI'leri hâlâ kabul ediliyor.

---

## Değişen / Eklenen Dosyalar

**Yeni:**
- `supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql` / `.down.sql`
- `lib/server/document-insert-atomic.ts`
- `tests/integration/phase6-hardening-staging.test.ts`
- `docs/production-readiness/PHASE-6-HARDENING-REPORT.md` (bu dosya)

**Değiştirilen:**
- `lib/server/verify-tx.ts` — `VerifyResult`'a `lamportsFound` eklendi (sadece `verifySolTransfer` dolduruyor)
- `lib/server/pixel-insert-atomic.ts` — `paidLamports` parametresi, `InsertPixelsResult`'a `reason: "conflict" | "underpaid"` eklendi
- `lib/server/board-insert-atomic.ts` — aynı, board.exe için
- `app/api/pixels/route.ts` — `handleBuy`/`handleBuyArea`, gerçek doğrulanmış lamports'u iletiyor ve `underpaid`'i ayrı mesajla karşılıyor
- `app/api/boards/route.ts` — `handleBuyBoard`, aynı
- `app/api/documents/route.ts` — `insertDocumentAtomic`'e geçirildi, best-effort ledger tamamen kaldırıldı
- `lib/server/intent-db-supabase.ts` — `expireStaleIntents()` eklendi
- `lib/server/intent-db.ts` — `createIntent`'in Supabase yolunda fire-and-forget süpürme tetiklemesi eklendi
- `lib/pixel-types.ts` — `isSafeImageUrl` daraltıldı
- `tests/pixel-types.test.ts` — 4 yeni test
- `tests/integration/phase4-treasury-atomicity-staging.test.ts` — iki doğrudan RPC çağrısına `p_paid_lamports` eklendi (yeni zorunlu parametre nedeniyle, davranış değişikliği yok — sadece uyum)

---

## Kapsam Dışında Kalanlar (bilinçli)

- **BULGU 4, 5, 6** — bu fazın hedefi değildi, dokunulmadı. Hâlâ `RED-TEAM-FINDINGS.md`'de açık.
- **`documents` için advisory lock** — gerekmedi (sabit fiyat, bonding curve yok).
- **`purchase_intents`'in gerçek zamanlı otomatik süpürülmesi (cron)** — `expire_stale_purchase_intents()` çağrılabilir durumda ve intent oluşturma anında opportunistically tetikleniyor, ama Vercel'de gerçek bir zamanlanmış cron job'a (ya da Supabase `pg_cron`'a) BAĞLANMADI — bu, altyapı kurulum kararı gerektiriyor (Phase 5'in "Vercel env/deploy" kapsamına daha yakın) ve bu fazın açık kapsamının dışında bırakıldı.

---

*Bu doküman, canlı Supabase projesine (`hjziuadsnlofgarjsawy`) uygulanan gerçek migration ve çalıştırılan gerçek RED TEAM entegrasyon testleriyle doğrulanarak hazırlanmıştır. Hiçbir secret değeri bu dosyaya yazılmamıştır.*
