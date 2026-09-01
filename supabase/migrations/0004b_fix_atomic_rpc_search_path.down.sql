-- 0004b_fix_atomic_rpc_search_path — DOWN. Reverts both functions to a
-- mutable search_path (not recommended — restores the linter WARN).
alter function public.update_pixel_owner_atomic(
  bigint, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
) reset search_path;

alter function public.update_board_pixel_owner_atomic(
  text, int, text, jsonb, text, text, text, numeric, text, uuid, text, text, boolean
) reset search_path;
