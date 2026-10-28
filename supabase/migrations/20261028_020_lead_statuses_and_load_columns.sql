-- DEBOSS GLOBAL: new lead statuses and the Sales load columns (part 1 of 2).
-- Run after 20261028_019_load_details_and_profit.sql, then run 20261028_021_move_lead_statuses.sql on its own.
-- (Postgres only lets a new status be used after the statement that adds it has finished, so the data move is separate.)
-- Safe to re-run. Adds statuses and columns only.
--
-- From the client's "Brokerage Flow and Scenarios" (v2, section 3.2):
--   Lead -> Qualified -> Quoting -> Customer, or Lead -> Not qualified / Not interested.
--   Qualified creates the customer profile; saving a quote sets Quoting; entering the agreed rate sets Customer.
--   Each customer's Loads / Quotes sheet: Date, Pickup, Delivery, Miles, Truck, Weight, Commodity, Quoted, Agreed, Notes.
-- The old values New, Contacted and Lost stay in the type (Postgres can't drop enum values) but are no longer used.

alter type public.lead_stage add value if not exists 'LEAD' before 'NEW';
alter type public.lead_stage add value if not exists 'QUOTING' after 'QUALIFIED';
alter type public.lead_stage add value if not exists 'NOT_QUALIFIED';
alter type public.lead_stage add value if not exists 'NOT_INTERESTED';

-- Loads: Miles and Notes are new. Weight and Commodity reuse the commodity fields from migration 019,
-- so Sales and Operations share one value. Date is the pickup date; Truck is the equipment type.
alter table public.brokerage_shipments
  add column if not exists miles numeric(10,1) check (miles is null or miles >= 0),
  add column if not exists load_notes text;
