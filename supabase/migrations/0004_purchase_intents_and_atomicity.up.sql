-- 0004_purchase_intents_and_atomicity — SOL-98 Phase 3 (MARKET SECURITY).
--
-- Closes finding P2-F1 (transaction substitution): a peer-to-peer payment
-- was previously bound only to (buyer, seller, amount) — never to a
-- specific (board_id, pixel_index) — so a payment made in good faith for
-- one listing could be redeemed against any OTHER listing sharing the same
-- seller and price. See docs/production-readiness/PHASE-2-PAYMENT-SECURITY.md
-- and docs/production-readiness/PHASE-3-MARKET-SECURITY.md.
--
-- Also closes finding P2-F4 (ledger completeness): the ownership mutation
-- and its payment_transactions / pixel_ownership_history rows were
-- previously three independent PostgREST writes with no atomicity between
-- them. `update_pixel_owner_atomic` / `update_board_pixel_owner_atomic`
-- below run all of it as ONE Postgres function invocation — the entire
-- function body is one transaction, so a failure at any INSERT rolls back
-- every UPDATE/INSERT already executed earlier in the same call.
--
-- purchase_intents is a server-issued, single-use, wallet-bound,
-- time-bound reservation. The client commits to a specific
-- (action_type, board_id, pixel_index) BEFORE paying; the server derives
-- who/what/how-much EXCLUSIVELY from this row at redemption time, never
-- from client-submitted values in the payment request itself.
create table if not exists public.purchase_intents (
  id uuid primary key default gen_random_uuid(),
  action_type text not null check (action_type in ('buy-listing', 'rent', 'hijack')),
  board_id text,                          -- null = main pixel board; else a Start Ads board.exe id
  pixel_index bigint not null,
  buyer_wallet text not null,
  seller_wallet text not null,
  currency text not null default 'SOL' check (currency in ('SOL', 'PIXEL98')),
  price_sol numeric,
  price_pixel98 numeric,
  mint text,
  rent_days int,
  status text not null default 'pending' check (status in ('pending', 'consumed', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by_signature text
);
alter table public.purchase_intents enable row level security;

create index if not exists idx_intents_buyer
  on public.purchase_intents (buyer_wallet, status, created_at);

create index if not exists idx_intents_target
  on public.purchase_intents (board_id, pixel_index, status);

-- ---------------------------------------------------------------------------
-- update_pixel_owner_atomic — main pixel board (board_id IS NULL semantics
-- handled entirely in application code; this function only ever touches
-- `public.pixels`, which has no board_id column).
--
-- Single Postgres transaction covering:
--   1. the conditional ownership UPDATE (same WHERE-guarded pattern as
--      pixel-db-supabase.ts's updateOwnedPixel/hijackPixel — re-verified
--      against the LIVE row, closing the same cross-instance race those
--      already closed);
--   2. atomically consuming the purchase_intent (if one was passed) —
--      RAISEs (and thus rolls back step 1) if it is missing, not pending,
--      or expired, so a stale/foreign/reused intent can NEVER be the
--      reason an ownership row changes;
--   3. the payment_transactions ledger insert;
--   4. the pixel_ownership_history insert, when p_record_history is true
--      (false for `rent`, which changes usage rights, not owner — mirrors
--      the existing convention in ownership-history.ts).
-- A RAISE EXCEPTION at any later step rolls back every earlier statement in
-- this same function call — there is no path where the ownership UPDATE
-- commits but the ledger insert is silently lost, or vice versa.
create or replace function public.update_pixel_owner_atomic(
  p_index bigint,
  p_expected_owner text,
  p_new_data jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text,
  p_intent_id uuid,
  p_prev_owner text,
  p_new_owner text,
  p_record_history boolean
) returns table(ok boolean, reason text, data jsonb)
language plpgsql
as $func$
declare
  v_updated jsonb;
  v_rows int;
begin
  update public.pixels
    set data = p_new_data
    where index = p_index and data->>'owner' = p_expected_owner
    returning data into v_updated;

  if v_updated is null then
    return query select false, 'conflict'::text, null::jsonb;
    return;
  end if;

  if p_intent_id is not null then
    update public.purchase_intents
      set status = 'consumed', consumed_at = now(), consumed_by_signature = p_signature
      where id = p_intent_id and status = 'pending' and expires_at > now();
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'purchase_intent_invalid: % is not a pending, unexpired intent', p_intent_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.payment_transactions (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  if p_record_history then
    insert into public.pixel_ownership_history (pixel_index, board_id, prev_owner, new_owner, action, signature)
      values (p_index, null, p_prev_owner, p_new_owner, p_action, p_signature);
  end if;

  return query select true, null::text, v_updated;
end;
$func$;

-- ---------------------------------------------------------------------------
-- update_board_pixel_owner_atomic — Start Ads sub-blocks (composite key:
-- board_id + index). Same shape and same guarantees as
-- update_pixel_owner_atomic above, threading board_id through the
-- conditional UPDATE and into the history row.
create or replace function public.update_board_pixel_owner_atomic(
  p_board_id text,
  p_index int,
  p_expected_owner text,
  p_new_data jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text,
  p_intent_id uuid,
  p_prev_owner text,
  p_new_owner text,
  p_record_history boolean
) returns table(ok boolean, reason text, data jsonb)
language plpgsql
as $func$
declare
  v_updated jsonb;
  v_rows int;
begin
  update public.board_pixels
    set data = p_new_data
    where board_id = p_board_id and index = p_index and data->>'owner' = p_expected_owner
    returning data into v_updated;

  if v_updated is null then
    return query select false, 'conflict'::text, null::jsonb;
    return;
  end if;

  if p_intent_id is not null then
    update public.purchase_intents
      set status = 'consumed', consumed_at = now(), consumed_by_signature = p_signature
      where id = p_intent_id and status = 'pending' and expires_at > now();
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'purchase_intent_invalid: % is not a pending, unexpired intent', p_intent_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.payment_transactions (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  if p_record_history then
    insert into public.pixel_ownership_history (pixel_index, board_id, prev_owner, new_owner, action, signature)
      values (p_index, p_board_id, p_prev_owner, p_new_owner, p_action, p_signature);
  end if;

  return query select true, null::text, v_updated;
end;
$func$;
