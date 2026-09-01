-- 0004_purchase_intents_and_atomicity — DOWN.
-- DESTRUCTIVE — staging/test only, after a verified backup. Drops both RPC
-- functions and the purchase_intents table (and its indexes). Does NOT
-- touch pixels / board_pixels / payment_transactions /
-- pixel_ownership_history — those are owned by earlier migrations.
drop function if exists public.update_board_pixel_owner_atomic(
  text, int, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
);
drop function if exists public.update_pixel_owner_atomic(
  bigint, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
);

drop index if exists public.idx_intents_target;
drop index if exists public.idx_intents_buyer;
drop table if exists public.purchase_intents;
