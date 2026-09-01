-- Reverts 0007: back to the original 3-value action_type constraint. Will
-- fail if any 'buy-valuation' intent rows still exist — delete/expire those
-- first if you need to roll this back on a database that has used the
-- feature.
alter table public.purchase_intents drop constraint if exists purchase_intents_action_type_check;
alter table public.purchase_intents add constraint purchase_intents_action_type_check
  check (action_type in ('buy-listing', 'rent', 'hijack'));
