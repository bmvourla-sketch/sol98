-- 0007_buy_valuation_action — adds "buy-valuation": an always-available
-- direct purchase of ANY owned spot (main board or a Start Ads sub-block) at
-- its current on-record valuationSol, with no listing required from the
-- owner. Closes the loop the whitepaper describes: buying a spot raises its
-- valuation +10% (already true — a spot's valuationSol is set from the
-- bonding-curve price paid), hijacking it lowers valuation −5%
-- (HIJACK_VALUATION_DECAY, already true) — this migration is what lets a
-- THIRD PARTY actually pay that current valuation to take ownership without
-- the current owner having to list it first, and bump it +10% again on
-- success. See app/api/pixels/route.ts's handleBuyValuation and
-- app/api/boards/route.ts's equivalent for the redemption logic, and
-- lib/token.ts / lib/pixel-store.tsx / lib/board-store.tsx for the client
-- side.
--
-- purchase_intents.action_type only allowed ('buy-listing', 'rent',
-- 'hijack') as of 0004 — widen it to include 'buy-valuation'. No other
-- table/column is constrained by action type (payment_transactions.action
-- and pixel_ownership_history.action are free text), so this is the only
-- schema change needed.
alter table public.purchase_intents drop constraint if exists purchase_intents_action_type_check;
alter table public.purchase_intents add constraint purchase_intents_action_type_check
  check (action_type in ('buy-listing', 'rent', 'hijack', 'buy-valuation'));
