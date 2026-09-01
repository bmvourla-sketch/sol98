-- 0006_hardening_price_lock_documents_intent_expiry — SOL-98 Phase 6
-- (RED-TEAM HARDENING & SECURITY REMEDIATION).
--
-- Closes three of the seven findings in
-- docs/production-readiness/RED-TEAM-FINDINGS.md:
--
--   BULGU 1 (HIGH) — bonding-curve price race: buy / buy-area / buy-board
--   computed price from an unlocked `soldCount()`/`countBoardFiles()` read
--   in application code, fully decoupled from the atomic INSERT that
--   followed. Two concurrent requests (across serverless instances — the
--   app's own mutex is documented as process-local only, see
--   lib/server/mutex.ts) could both read the SAME stale count and both
--   underpay relative to the true bonding-curve price. Fixed by moving the
--   price decision INTO insert_pixels_atomic / insert_board_pixels_atomic,
--   guarded by pg_advisory_xact_lock so the count-read + price-check +
--   insert become one serialized, cross-instance-atomic unit: whichever
--   request's transaction acquires the lock first sees the TRUE count at
--   that moment, and every later concurrent request — once it gets the
--   lock — sees the FIRST request's insert already committed, so it is
--   priced (and thus payment-checked) correctly instead of racing. The
--   actual verified on-chain payment (not the caller's own possibly-stale
--   price guess) is what's compared against this freshly-computed floor —
--   see lib/server/verify-tx.ts's new `lamportsFound` return value and
--   app/api/pixels/route.ts / app/api/boards/route.ts's updated handlers.
--
--   BULGU 2 (MEDIUM) — documents purchases never got the P2-F4 atomic-
--   ledger treatment pixel/board purchases received in Phase 3/4:
--   createDocument() was followed by a SEPARATE best-effort (never-throws)
--   recordPaymentTransaction() call, so a transient failure on the ledger
--   write could leave a real, paid sale with no payment_transactions row.
--   insert_document_atomic closes this the same way 0005 did for pixels/
--   boards: one plpgsql function, one transaction, both INSERTs together.
--
--   BULGU 3 (MEDIUM) — purchase_intents.status declares 'expired' /
--   'cancelled' in its check constraint, but nothing ever wrote them; rows
--   stayed 'pending' forever once abandoned, growing the table without
--   bound. expire_stale_purchase_intents() is exposed as a callable RPC —
--   wired as a cheap, best-effort, non-blocking opportunistic sweep from
--   lib/server/intent-db-supabase.ts's createIntent (see that file), and
--   also safe to attach to a scheduled job (pg_cron / a Vercel cron route)
--   later without any further schema change.

-- ---------------------------------------------------------------------------
-- Pricing helpers — pure functions, no table access, mirroring lib/pricing.ts
-- (main board) and lib/board-types.ts (board.exe) exactly, plus the SAME
-- 0.5% tolerance lib/server/verify-tx.ts's solRequiredLamportsWithTolerance
-- already applies (kept identical so legitimate float-precision differences
-- between the JS and SQL implementations of the same formula never cause a
-- false "underpaid" rejection).
-- ---------------------------------------------------------------------------
create or replace function public.min_lamports_with_tolerance(p_sol double precision)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select floor(round(p_sol * 1000000000::double precision) * 0.995)::bigint;
$$;

-- Main board: price(N) = 0.2 * 1.1^(N-1), 1-indexed. Bulk purchases step the
-- price up 10% every 10 blocks within the SAME purchase (lib/pricing.ts's
-- bulkBlockPrice/areaPrice) — areaPrice(soldCount, 1) reduces to exactly
-- nextSpotPrice(soldCount), so this single function correctly prices both a
-- single `buy` (count=1) and a bulk `buy-area` (count=N).
create or replace function public.area_price_min_lamports(p_sold_count bigint, p_count int)
returns bigint
language plpgsql
immutable
set search_path = ''
as $func$
declare
  v_next double precision := 0.2::double precision * power(1.1::double precision, p_sold_count::double precision);
  v_total double precision := 0;
  v_k int;
begin
  for v_k in 0..(p_count - 1) loop
    v_total := v_total + v_next * power(1.1::double precision, (v_k / 10)::double precision);
  end loop;
  return public.min_lamports_with_tolerance(v_total);
end;
$func$;

-- board.exe: price(N) = 2 * 1.1^(N-1), 1-indexed, always one file per
-- purchase (lib/board-types.ts's boardFilePrice/nextBoardFilePrice).
create or replace function public.next_board_file_min_lamports(p_sold_count bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select public.min_lamports_with_tolerance(2.0::double precision * power(1.1::double precision, p_sold_count::double precision));
$$;

-- ---------------------------------------------------------------------------
-- insert_pixels_atomic — replaces the 0005 version. Adds p_paid_lamports
-- (the caller's ALREADY on-chain-verified transferred amount — see
-- verifySolTransfer's new lamportsFound field) and a
-- pg_advisory_xact_lock-guarded fresh price check before the insert.
-- ---------------------------------------------------------------------------
drop function if exists public.insert_pixels_atomic(jsonb, text, text, text, numeric, text);

create or replace function public.insert_pixels_atomic(
  p_records jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text,
  p_paid_lamports bigint
) returns table(ok boolean, reason text, taken bigint[])
language plpgsql
set search_path = ''
as $func$
declare
  v_taken bigint[];
  v_sold_count bigint;
  v_required_lamports bigint;
begin
  -- Cross-instance serialization point: only one treasury pixel purchase
  -- (single or bulk) is ever "deciding its price" at a time, system-wide.
  -- xact-scoped — released automatically at this function call's commit or
  -- rollback, safe under PostgREST's one-call-one-transaction model and
  -- under connection pooling (nothing session-scoped is held open).
  perform pg_advisory_xact_lock(hashtextextended('sol98:pixels:treasury', 0));

  select count(*) into v_sold_count from public.pixels as pix;
  v_required_lamports := public.area_price_min_lamports(v_sold_count, jsonb_array_length(p_records));

  if p_paid_lamports < v_required_lamports then
    return query select false, 'underpaid'::text, '{}'::bigint[];
    return;
  end if;

  begin
    insert into public.pixels as pix (index, data)
    select (r->>'index')::bigint, r
    from jsonb_array_elements(p_records) as r;
  exception when unique_violation then
    select array_agg(pix.index) into v_taken
    from public.pixels as pix
    where pix.index in (
      select (r->>'index')::bigint from jsonb_array_elements(p_records) as r
    );
    return query select false, 'conflict'::text, coalesce(v_taken, '{}'::bigint[]);
    return;
  end;

  insert into public.payment_transactions as pay (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  insert into public.pixel_ownership_history as hist (pixel_index, board_id, prev_owner, new_owner, action, signature)
    select (r->>'index')::bigint, null, null, p_wallet, p_action, p_signature
    from jsonb_array_elements(p_records) as r;

  return query select true, null::text, '{}'::bigint[];
end;
$func$;

-- ---------------------------------------------------------------------------
-- insert_board_pixels_atomic — same treatment for buy-board.
-- ---------------------------------------------------------------------------
drop function if exists public.insert_board_pixels_atomic(text, jsonb, jsonb, text, text, text, numeric, text);

create or replace function public.insert_board_pixels_atomic(
  p_file_id text,
  p_file_data jsonb,
  p_records jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text,
  p_paid_lamports bigint
) returns table(ok boolean, reason text)
language plpgsql
set search_path = ''
as $func$
declare
  v_sold_count bigint;
  v_required_lamports bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('sol98:boards:treasury', 0));

  select count(*) into v_sold_count from public.board_files;
  v_required_lamports := public.next_board_file_min_lamports(v_sold_count);

  if p_paid_lamports < v_required_lamports then
    return query select false, 'underpaid'::text;
    return;
  end if;

  begin
    insert into public.board_files as bf (id, data) values (p_file_id, p_file_data);
  exception when unique_violation then
    return query select false, 'already exists'::text;
    return;
  end;

  insert into public.board_pixels as bp (board_id, index, data)
    select p_file_id, (r->>'index')::int, r
    from jsonb_array_elements(p_records) as r;

  insert into public.payment_transactions as pay (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  insert into public.pixel_ownership_history as hist (pixel_index, board_id, prev_owner, new_owner, action, signature)
    select (r->>'index')::bigint, p_file_id, null, p_wallet, p_action, p_signature
    from jsonb_array_elements(p_records) as r;

  return query select true, null::text;
end;
$func$;

-- ---------------------------------------------------------------------------
-- insert_document_atomic — GÖREV 2 (BULGU 2). Fixed price (no bonding
-- curve, no advisory lock needed) — just closes the same ledger-atomicity
-- gap 0005 already closed for pixels/boards.
-- ---------------------------------------------------------------------------
create or replace function public.insert_document_atomic(
  p_doc jsonb,       -- {id, name, content, owner, purchasedAt}
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric
) returns table(ok boolean, reason text, doc jsonb)
language plpgsql
set search_path = ''
as $func$
declare
  v_doc jsonb;
begin
  begin
    insert into public.documents as d (id, name, content, owner, "purchasedAt")
      values (
        p_doc->>'id',
        p_doc->>'name',
        p_doc->>'content',
        p_doc->>'owner',
        (p_doc->>'purchasedAt')::bigint
      )
      returning jsonb_build_object(
        'id', d.id, 'name', d.name, 'content', d.content,
        'owner', d.owner, 'purchasedAt', d."purchasedAt"
      ) into v_doc;
  exception when unique_violation then
    return query select false, 'conflict'::text, null::jsonb;
    return;
  end;

  insert into public.payment_transactions as pay (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, null);

  return query select true, null::text, v_doc;
end;
$func$;

-- ---------------------------------------------------------------------------
-- expire_stale_purchase_intents — GÖREV 3 (BULGU 3). Callable on-demand
-- (wired as a best-effort opportunistic sweep — see intent-db-supabase.ts)
-- and equally suitable for a future pg_cron schedule; either way it is now
-- POSSIBLE for a row to actually reach 'expired', which was never true
-- before this migration.
-- ---------------------------------------------------------------------------
create or replace function public.expire_stale_purchase_intents()
returns integer
language plpgsql
set search_path = ''
as $func$
declare
  v_count integer;
begin
  update public.purchase_intents
    set status = 'expired'
    where status = 'pending' and expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$func$;
