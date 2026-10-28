-- DEBOSS GLOBAL: lead details for the Sales Leads sheet.
-- Run after 20261027_017_private_typing_channels.sql. Safe to re-run. Adds columns only; no data is removed.
--
-- The Sales Leads sheet (and the lead page) show the same company details a Fronter collects: operator, truck and
-- load type, volume, commodity, lanes, addresses, billing contact, payment terms, W-9 and EIN. Until now these lived
-- only on the Fronter's row; they now belong to the lead itself, so Sales can fill and edit them for any lead.

alter table public.sales_leads
  add column if not exists operator_name text,
  add column if not exists operator_number text,
  add column if not exists truck_type text,
  add column if not exists load_type text,
  add column if not exists shipping_volume text,
  add column if not exists commodity text,
  add column if not exists lanes text,
  add column if not exists physical_address text,
  add column if not exists other_locations text,
  add column if not exists billing_address text,
  add column if not exists billing_contact text,
  add column if not exists billing_phone text,
  add column if not exists billing_email text,
  add column if not exists payment_terms text,
  add column if not exists w9_received boolean not null default false,
  add column if not exists ein text,
  add column if not exists website text;

do $$ begin
  alter table public.sales_leads add constraint sales_leads_load_type_check check (load_type is null or load_type in ('FTL', 'LTL', 'BOTH'));
exception when duplicate_object then null; end $$;

-- Leads that came from a Fronter's sheet take over the details the Fronter collected (only where still empty).
update public.sales_leads l set
  operator_name = coalesce(l.operator_name, p.operator_name),
  operator_number = coalesce(l.operator_number, p.operator_number),
  truck_type = coalesce(l.truck_type, p.truck_type),
  load_type = coalesce(l.load_type, p.load_type),
  shipping_volume = coalesce(l.shipping_volume, p.shipping_volume),
  commodity = coalesce(l.commodity, p.commodity),
  lanes = coalesce(l.lanes, p.lanes),
  physical_address = coalesce(l.physical_address, p.physical_address),
  other_locations = coalesce(l.other_locations, p.other_locations),
  billing_address = coalesce(l.billing_address, p.billing_address),
  billing_contact = coalesce(l.billing_contact, p.billing_contact),
  billing_phone = coalesce(l.billing_phone, p.billing_phone),
  billing_email = coalesce(l.billing_email, p.billing_email),
  payment_terms = coalesce(l.payment_terms, p.payment_terms),
  w9_received = l.w9_received or p.w9_received,
  ein = coalesce(l.ein, p.ein),
  website = coalesce(l.website, p.website)
from public.fronter_prospects p
where p.id = l.fronter_prospect_id;
