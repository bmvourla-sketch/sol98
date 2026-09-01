-- 0004c_fix_atomic_rpc_ambiguous_data_column — bug found by
-- tests/integration/phase3-market-security-staging.test.ts's very first run
-- against real staging Postgres: `returning data into v_updated` was
-- ambiguous, because PL/pgSQL auto-declares OUT-parameter-style variables
-- for every column named in `returns table(...)` — and both RPC functions
-- declare a `data` output column, which collides with `public.pixels.data`
-- / `public.board_pixels.data`. Fixed by aliasing the target table and
-- qualifying every `data` reference against that alias. Also folds 0004b's
-- `set search_path = ''` directly into the function definition (harmless
-- to repeat — `create or replace function` fully replaces the function).
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
set search_path = ''
as $func$
declare
  v_updated jsonb;
  v_rows int;
begin
  update public.pixels as pix
    set data = p_new_data
    where pix.index = p_index and pix.data->>'owner' = p_expected_owner
    returning pix.data into v_updated;

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
set search_path = ''
as $func$
declare
  v_updated jsonb;
  v_rows int;
begin
  update public.board_pixels as bp
    set data = p_new_data
    where bp.board_id = p_board_id and bp.index = p_index and bp.data->>'owner' = p_expected_owner
    returning bp.data into v_updated;

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
