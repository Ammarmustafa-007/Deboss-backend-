-- =====================================================================================
-- DEBOSS GLOBAL: full reset that KEEPS only the departments (and the Super Admin)
-- (run ONCE, by hand, in the Supabase SQL editor; this file is NOT a migration)
--
-- Clears every person, team and record so the client starts clean. Afterwards the Super Admin
-- signs in, creates the users under Users (choosing each one's department and role), and the
-- managers build their teams again.
--
-- It KEEPS:
--   * every department exactly as it is
--   * the Super Admin login(s), so someone can still sign in and create the new users
--   * settings: commission rules (hr_settings) and the Brokerage Sales Manager switch
--   * the three chat channels (Company announcements, Quotes, Updates), emptied; people join
--     them automatically when they first open Chat
--
-- It DELETES:
--   * every other login and profile
--   * teams, team members, Team Lead access, agent permissions
--   * HR setup and history: salaries, joining dates, attendance, payroll, payslips, costs, targets
--   * Brokerage: leads, customers, quotes, loads, invoices, documents, events, activities, comments
--   * Fronters: mined prospects and the commodities sheet
--   * Dispatch: carriers, trucks, loads, invoices, documents, activities
--   * Chat: every message, direct conversation and team group
--   * notifications and the audit history
--
-- Everything runs in ONE transaction: if any step or check fails, nothing is changed.
-- Plain TRUNCATE (no CASCADE) is used on purpose: if some table still pointed at the cleared
-- data, the script stops instead of silently clearing more than listed here.
--
-- After running it, empty all four Storage buckets (Dashboard → Storage → bucket menu → "Empty bucket"):
--   brokerage-documents, brokerage-quote-attachments, dispatch-documents, chat-photos
-- Supabase blocks deleting stored files with SQL, so this step is done in the dashboard.
-- =====================================================================================

-- STEP 0 (optional, read-only): preview. Run this block alone first.
-- select 'KEEP departments' as item, count(*) from public.departments
-- union all select 'KEEP super admins', count(*) from public.profiles where role = 'SUPER_ADMIN'
-- union all select 'delete other people', count(*) from public.profiles where role <> 'SUPER_ADMIN'
-- union all select 'delete teams', count(*) from public.teams
-- union all select 'delete leads', count(*) from public.sales_leads
-- union all select 'delete brokerage loads', count(*) from public.brokerage_shipments
-- union all select 'delete fronter prospects', count(*) from public.fronter_prospects
-- union all select 'delete dispatch carriers', count(*) from public.dispatch_carriers
-- union all select 'delete chat messages', count(*) from public.chat_messages;

begin;

-- 1. Safety check: stop if there is no active Super Admin with a login to keep.
do $$
begin
  if not exists (select 1 from public.profiles p join auth.users u on u.id = p.id where p.role = 'SUPER_ADMIN' and p.is_active) then
    raise exception 'Aborted: no active Super Admin with a login was found. Nothing was changed.';
  end if;
end $$;

-- 2. Remember what must survive, to compare at the end.
create temporary table reset_kept on commit drop as
select (select count(*) from public.departments) as departments,
       (select count(*) from public.profiles where role = 'SUPER_ADMIN') as super_admins;

-- 3. All records, teams and people's setup.
truncate table
  -- Brokerage
  public.quote_events,
  public.quote_attachments,
  public.shipment_events,
  public.shipment_documents,
  public.brokerage_invoices,
  public.brokerage_shipments,
  public.sales_quotes,
  public.lead_activities,
  public.record_comments,
  public.brokerage_customers,
  public.sales_leads,
  -- Fronters
  public.fronter_prospects,
  public.fronter_commodities,
  -- Dispatch
  public.dispatch_invoices,
  public.dispatch_loads,
  public.dispatch_activities,
  public.dispatch_carrier_documents,
  public.dispatch_trucks,
  public.dispatch_carriers,
  public.dispatch_targets,
  -- HR and payroll
  public.attendance_records,
  public.payroll_lines,
  public.payroll_runs,
  public.payroll_months,
  public.department_costs,
  public.ownership_transfers,
  public.employee_records,
  public.compensation_settings,
  -- Teams and access
  public.team_lead_permissions,
  public.team_members,
  public.user_permissions,
  -- Messages, notifications, history
  public.chat_messages,
  public.notifications,
  public.audit_events
restart identity;

-- 4. Chat: keep only the three channels, emptied (direct conversations and team groups go, with their members).
delete from public.chat_conversations where kind <> 'CHANNEL';
update public.chat_conversations set last_message_at = null;

-- 5. Teams. Removed with DELETE, not TRUNCATE: chat conversations point at teams, which blocks TRUNCATE
--    even though the team groups are already gone (step 4).
delete from public.teams;

-- 6. Every login except the Super Admin(s). Profiles go with their login (on delete cascade);
--    the second statement catches any profile without a login.
delete from auth.users
where id not in (select id from public.profiles where role = 'SUPER_ADMIN');

delete from public.profiles
where role <> 'SUPER_ADMIN';

-- 7. Final check before committing: departments and Super Admins untouched, nobody else left.
do $$
declare kept record;
begin
  select * into kept from reset_kept;
  if (select count(*) from public.departments) <> kept.departments
     or (select count(*) from public.profiles where role = 'SUPER_ADMIN') <> kept.super_admins
     or exists (select 1 from public.profiles where role <> 'SUPER_ADMIN') then
    raise exception 'Aborted: departments or Super Admins changed, or other people remain. Nothing was changed.';
  end if;
end $$;

commit;

-- 8. Verification (read-only). Expect the KEEP rows unchanged and 0 everywhere else.
select 'KEEP departments' as item, count(*) as rows from public.departments
union all select 'KEEP super admin profiles', count(*) from public.profiles
union all select 'KEEP logins (super admin)', count(*) from auth.users
union all select 'KEEP chat channels', count(*) from public.chat_conversations
union all select 'teams', count(*) from public.teams
union all select 'sales_leads', count(*) from public.sales_leads
union all select 'brokerage_customers', count(*) from public.brokerage_customers
union all select 'brokerage_shipments', count(*) from public.brokerage_shipments
union all select 'fronter_prospects', count(*) from public.fronter_prospects
union all select 'dispatch_carriers', count(*) from public.dispatch_carriers
union all select 'dispatch_invoices', count(*) from public.dispatch_invoices
union all select 'chat_messages', count(*) from public.chat_messages
union all select 'notifications', count(*) from public.notifications
union all select 'audit_events', count(*) from public.audit_events;
