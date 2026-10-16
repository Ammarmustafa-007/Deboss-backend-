-- DEBOSS GLOBAL: retain both the proposed and agreed commercial values.
-- Run after 20261016_011_brokerage_activity_completion.sql.

alter table public.brokerage_shipments
  add column if not exists amount_agreed numeric(12,2);
