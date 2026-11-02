-- DEBOSS GLOBAL: each Fronter works for one Brokerage Sales agent. Run after 20261103_026_dispatch_invoice_loads.sql.
-- Safe to re-run. The Super Admin picks the agent when creating a Fronter; a lead the Fronter qualifies goes to them.

alter table public.profiles add column if not exists sales_agent_id uuid references public.profiles(id) on delete set null;
