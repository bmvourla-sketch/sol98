-- Reverts 0008: restores the +10%/sale minimum-payment curve.

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

create or replace function public.next_board_file_min_lamports(p_sold_count bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select public.min_lamports_with_tolerance(2.0::double precision * power(1.1::double precision, p_sold_count::double precision));
$$;
