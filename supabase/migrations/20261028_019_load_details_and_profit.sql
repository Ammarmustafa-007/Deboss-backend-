-- DEBOSS GLOBAL: Brokerage load details, carrier rate and profit, Missed pickup and Cancelled.
-- Run after 20261028_018_lead_details.sql. Safe to re-run. Adds columns and statuses only; no data is changed.
--
-- From the client's "Brokerage Flow and Scenarios" (v2, section 3.3):
--   * Carrier details (MC #, company, dispatcher, driver, truck and trailer) that the Operations Agent enters.
--     The API never sends these to Brokerage Sales; Sales sees only the carrier rate and the profit.
--   * Carrier rate. Profit = agreed rate - carrier rate; profit % = profit / agreed rate.
--   * Pickup details (facility, address, contact, notes, PO #), delivery details and commodity details.
--   * Two new load statuses: Missed pickup (re-book or cancel) and Cancelled (a reason is required).
-- Carrier assigned, In transit and Exception stay as they are until the client confirms otherwise.

alter type public.shipment_stage add value if not exists 'MISSED_PICKUP' after 'CARRIER_ASSIGNED';
alter type public.shipment_stage add value if not exists 'CANCELLED';

alter table public.brokerage_shipments
  -- Carrier (Operations only). carrier_name already exists and is the carrier's company name.
  add column if not exists carrier_mc text,
  add column if not exists dispatcher_name text,
  add column if not exists dispatcher_phone text,
  add column if not exists dispatcher_email text,
  add column if not exists driver_name text,
  add column if not exists driver_phone text,
  add column if not exists truck_type_size text,
  add column if not exists truck_number text,
  add column if not exists trailer_number text,
  add column if not exists carrier_rate numeric(12,2) check (carrier_rate is null or carrier_rate >= 0),
  -- Pickup and delivery
  add column if not exists pickup_facility text,
  add column if not exists pickup_address text,
  add column if not exists pickup_contact text,
  add column if not exists pickup_notes text,
  add column if not exists pickup_po text,
  add column if not exists delivery_facility text,
  add column if not exists delivery_address text,
  add column if not exists delivery_contact text,
  add column if not exists delivery_notes text,
  -- Commodity
  add column if not exists commodity_product text,
  add column if not exists commodity_weight text,
  add column if not exists commodity_pieces text,
  -- Missed pickup and cancellation
  add column if not exists missed_pickup_reason text,
  add column if not exists cancel_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id) on delete set null;
