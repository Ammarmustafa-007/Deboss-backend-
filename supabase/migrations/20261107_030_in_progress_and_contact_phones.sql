-- DEBOSS GLOBAL: "In progress" load status and the points of contact's phone numbers.
-- Run after 20261105_029_brokerage_settings.sql. Safe to re-run.
-- Run 20261107_031_in_progress_backfill.sql AFTER this one, as a separate step: a new status value can only be used
-- once this has been committed.
--
-- Load lifecycle (client feedback): In progress -> Booked -> Picked up -> Delivered -> Completed (when the invoice is paid).
-- A load handed to Operations is In progress until a carrier and its carrier rate are saved; then it becomes Booked.

alter type public.shipment_stage add value if not exists 'IN_PROGRESS' before 'BOOKED';

alter table public.brokerage_shipments add column if not exists pickup_contact_phone text check (pickup_contact_phone is null or char_length(pickup_contact_phone) <= 40);
alter table public.brokerage_shipments add column if not exists delivery_contact_phone text check (delivery_contact_phone is null or char_length(delivery_contact_phone) <= 40);
