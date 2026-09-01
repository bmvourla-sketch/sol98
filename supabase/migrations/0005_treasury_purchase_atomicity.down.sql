-- 0005_treasury_purchase_atomicity — DOWN.
drop function if exists public.insert_pixels_atomic(jsonb, text, text, text, numeric, text);
drop function if exists public.insert_board_pixels_atomic(text, jsonb, jsonb, text, text, text, numeric, text);
