-- =====================================================================================
-- DEBOSS GLOBAL: clear all records but KEEP the people and departments
-- (run ONCE, by hand, in the Supabase SQL editor; this file is NOT a migration)
--
-- KEEPS: every login and profile, departments, teams and their members, Team Lead access, agent
-- permissions, people's HR setup (salaries, joining dates, targets), settings, and the chat channels
-- and groups (emptied).
-- DELETES: leads, customers, quotes, loads, invoices, documents, events, activities, comments,
-- Fronter prospects and commodities, Dispatch carriers, trucks, loads and invoices, chat messages and
-- direct conversations, attendance, payroll and costs, notifications and the audit history.
--
-- One transaction: if anything fails, nothing changes. Plain TRUNCATE (no CASCADE) so nothing beyond
-- this list can be cleared by accident.
-- Afterwards empty the Storage buckets brokerage-documents, brokerage-quote-attachments and
-- dispatch-documents (Dashboard -> Storage -> bucket menu -> "Empty bucket").
-- =====================================================================================

begin;

create temporary table reset_kept on commit drop as
select (select count(*) from auth.users) as logins,
       (select count(*) from public.profiles) as profiles,
       (select count(*) from public.departments) as departments,
       (select count(*) from public.teams) as teams;

truncate table
  public.quote_events, public.quote_attachments, public.shipment_events, public.shipment_documents,
  public.brokerage_invoices, public.brokerage_shipments, public.sales_quotes, public.lead_activities,
  public.record_comments, public.brokerage_customers, public.sales_leads,
  public.fronter_prospects, public.fronter_commodities,
  public.dispatch_invoices, public.dispatch_loads, public.dispatch_activities, public.dispatch_carrier_documents,
  public.dispatch_trucks, public.dispatch_carriers,
  public.attendance_records, public.payroll_lines, public.payroll_runs, public.payroll_months,
  public.department_costs, public.ownership_transfers,
  public.chat_messages, public.notifications, public.audit_events
restart identity;

-- Chat: one-to-one conversations go; channels and groups stay, emptied.
delete from public.chat_conversations where kind = 'DIRECT';
update public.chat_conversations set last_message_at = null;

do $$
declare kept record;
begin
  select * into kept from reset_kept;
  if (select count(*) from auth.users) <> kept.logins
     or (select count(*) from public.profiles) <> kept.profiles
     or (select count(*) from public.departments) <> kept.departments
     or (select count(*) from public.teams) <> kept.teams then
    raise exception 'Aborted: people, departments or teams changed. Nothing was changed.';
  end if;
end $$;

commit;

-- Check (read-only): people and departments unchanged, records at 0.
select 'KEEP profiles' as item, count(*) as rows from public.profiles
union all select 'KEEP departments', count(*) from public.departments
union all select 'sales_leads', count(*) from public.sales_leads
union all select 'brokerage_shipments', count(*) from public.brokerage_shipments
union all select 'brokerage_invoices', count(*) from public.brokerage_invoices
union all select 'dispatch_carriers', count(*) from public.dispatch_carriers
union all select 'chat_messages', count(*) from public.chat_messages
union all select 'audit_events', count(*) from public.audit_events;
