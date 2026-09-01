-- Reverts 0006: drops the new functions and restores insert_pixels_atomic /
-- insert_board_pixels_atomic to their exact pre-Phase-6 (0005) definitions —
-- no advisory lock, no price re-check, original 6/8-argument signatures.

drop function if exists public.expire_stale_purchase_intents();
drop function if exists public.insert_document_atomic(jsonb, text, text, text, numeric);
drop function if exists public.insert_board_pixels_atomic(text, jsonb, jsonb, text, text, text, numeric, text, bigint);
drop function if exists public.insert_pixels_atomic(jsonb, text, text, text, numeric, text, bigint);
drop function if exists public.next_board_file_min_lamports(bigint);
drop function if exists public.area_price_min_lamports(bigint, int);
drop function if exists public.min_lamports_with_tolerance(double precision);

create or replace function public.insert_pixels_atomic(
  p_records jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text
) returns table(ok boolean, reason text, taken bigint[])
language plpgsql
set search_path = ''
as $func$
declare
  v_taken bigint[];
begin
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

create or replace function public.insert_board_pixels_atomic(
  p_file_id text,
  p_file_data jsonb,
  p_records jsonb,
  p_signature text,
  p_wallet text,
  p_action text,
  p_amount_sol numeric,
  p_mint text
) returns table(ok boolean, reason text)
language plpgsql
set search_path = ''
as $func$
begin
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
