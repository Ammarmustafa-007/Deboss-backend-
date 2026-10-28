-- DEBOSS GLOBAL: move leads to the new statuses (part 2 of 2).
-- Run after 20261028_020_lead_statuses_and_load_columns.sql has finished. Safe to re-run.
--
-- New and Contacted become Lead; Lost becomes Not interested. Qualified and Customer are unchanged.
-- No customer profiles are created here: leads already Qualified get theirs the next time an agent works them.

update public.sales_leads set stage = 'LEAD' where stage in ('NEW', 'CONTACTED');
update public.sales_leads set stage = 'NOT_INTERESTED' where stage = 'LOST';

alter table public.sales_leads alter column stage set default 'LEAD';
