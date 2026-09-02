-- ---------------------------------------------------------------------------
-- 0008_soften_bonding_curve_5pct — lowers the bonding-curve growth rate from
-- +10%/sale to +5%/sale for BOTH the main board and board.exe, matching the
-- same change just made to lib/pricing.ts's PRICE_INCREASE and
-- lib/board-types.ts's BOARD_FILE_PRICE_INCREASE (both 0.1 -> 0.05).
--
-- These two SQL functions are the server-side MINIMUM-PAYMENT check used by
-- insert_pixels_atomic / the board.exe purchase path — they must stay in
-- lockstep with the client-side curve in lib/pricing.ts / lib/board-types.ts,
-- or a client that quotes the new (lower) 5% price will have its payment
-- rejected as underpaid against the old (higher) 10% minimum still live in
-- the database.
-- ---------------------------------------------------------------------------

create or replace function public.area_price_min_lamports(p_sold_count bigint, p_count int)
returns bigint
language plpgsql
immutable
set search_path = ''
as $func$
declare
  v_next double precision := 0.2::double precision * power(1.05::double precision, p_sold_count::double precision);
  v_total double precision := 0;
  v_k int;
begin
  for v_k in 0..(p_count - 1) loop
    v_total := v_total + v_next * power(1.05::double precision, (v_k / 10)::double precision);
  end loop;
  return public.min_lamports_with_tolerance(v_total);
end;
$func$;

create or replace function public.next_board_file_min_lamports(p_sold_count bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select public.min_lamports_with_tolerance(2.0::double precision * power(1.05::double precision, p_sold_count::double precision));
$$;
