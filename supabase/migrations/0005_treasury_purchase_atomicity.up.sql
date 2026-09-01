-- 0005_treasury_purchase_atomicity — SOL-98 Phase 4, GÖREV 2.
--
-- Phase 3 (0004/0004b/0004c) made the three UPDATE-based peer-to-peer
-- handlers (buy-listing / rent / hijack-live) atomic via
-- update_pixel_owner_atomic / update_board_pixel_owner_atomic, but explicitly
-- left the INSERT-based TREASURY purchase paths (buy / buy-area / buy-board)
-- out of scope (see docs/production-readiness/PHASE-3-MARKET-SECURITY.md
-- §4.4) — those still ran createPixels()/createBoard() followed by two
-- separate best-effort writes (payment_transactions, pixel_ownership_history)
-- with no atomicity between the three. This closes that gap the same way:
-- one plpgsql function = one Postgres transaction, covering the ownership
-- INSERT(s), the payment ledger INSERT, and the ownership history INSERT(s)
-- together. A RAISE'd/propagated exception at any step (e.g. a duplicate
-- payment_transactions.signature — see the RED TEAM #4-style staging test in
-- tests/integration/phase4-treasury-atomicity-staging.test.ts) rolls back
-- everything already executed in that same call, INCLUDING the pixel/board
-- rows that were just inserted.
--
-- Learned from the 0004 → 0004c debugging history: both functions are
-- written with `set search_path = ''` and fully-qualified, ALIASED table
-- references from the start (no bare `data`/`index`/`ok`/`reason`/`taken`
-- identifier ever collides with the plpgsql variables PL/pgSQL
-- auto-declares from `returns table(...)` — see 0004c's header comment for
-- the exact bug class this avoids).
create or replace function public.insert_pixels_atomic(
  p_records jsonb,      -- jsonb array of full PixelData objects (each has .index)
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
  -- The pixel INSERT is wrapped in its own exception block so an ordinary,
  -- expected "someone else just bought one of these spots" race (a unique-
  -- constraint hit on pixels.index) is reported back CLEANLY as
  -- (ok=false, reason='conflict', taken=[...]) — an implicit SAVEPOINT from
  -- the exception block rolls back just this INSERT attempt — instead of
  -- aborting the whole function call as an unhandled error. This preserves
  -- the exact caller contract createPixels() already had ("no partial
  -- write, tell me which indices were taken so I can 409").
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

  -- NOT wrapped in an exception block: a genuine ledger anomaly here (e.g.
  -- payment_transactions' own UNIQUE(signature) firing — normally prevented
  -- upstream by used_signatures.claimSignature(), so this should only ever
  -- fire in the adversarial/staging-test scenario or a real infra bug) must
  -- roll back the pixel row(s) just inserted above, not just itself.
  insert into public.payment_transactions as pay (signature, wallet, action, amount_sol, mint)
    values (p_signature, p_wallet, p_action, p_amount_sol, p_mint);

  insert into public.pixel_ownership_history as hist (pixel_index, board_id, prev_owner, new_owner, action, signature)
    select (r->>'index')::bigint, null, null, p_wallet, p_action, p_signature
    from jsonb_array_elements(p_records) as r;

  return query select true, null::text, '{}'::bigint[];
end;
$func$;

-- board.exe (Start Ads) mirror — additionally closes the non-atomicity
-- board-db-supabase.ts's createBoard() already documented in its own header
-- comment (file row inserted first, sub-blocks second, with a manual
-- best-effort compensating DELETE of the file row if the sub-block insert
-- failed — a real "half-created board.exe" window under a genuine DB error
-- between the two INSERTs). One transaction removes that window entirely.
create or replace function public.insert_board_pixels_atomic(
  p_file_id text,
  p_file_data jsonb,
  p_records jsonb,     -- jsonb array of full BoardPixel sub-block objects (each has .index)
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
    -- Board file ids are timestamp+random (see makeSubBlocks/handleBuyBoard)
    -- so a real collision is effectively impossible in practice; this
    -- branch exists for correctness, matching board-db-supabase.ts's
    -- createBoard 409 handling, not because it's expected to fire.
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
