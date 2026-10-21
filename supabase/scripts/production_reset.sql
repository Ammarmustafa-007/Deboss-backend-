-- =====================================================================================
-- DEBOSS GLOBAL: production reset (run ONCE, by hand, in the Supabase SQL editor)
--
-- Removes all test data so the client starts clean. It KEEPS:
--   * every table, column, policy, function and trigger (the schema is untouched)
--   * every Super Admin account (login + profile)
--   * every department exactly as it is (names and settings), so the Super Admin only
--     has to create users under Users and pick their department and role
--
-- It DELETES:
--   * all other user accounts (logins and profiles)
--   * leads, customers, quotes, shipments, invoices, documents, comments, activities,
--     notifications, audit history, teams, team-lead access, compensation and payroll
--   * Dispatch carriers, trucks, documents, activities, loads, weekly invoices and targets
--     (run after migration 015; also empty the dispatch-documents bucket)
--
-- Everything runs in ONE transaction: if any check fails, nothing is changed.
-- This file is NOT a migration. Do not add it to supabase/migrations.
--
-- After running it, also empty the two Storage buckets (Dashboard → Storage):
--   brokerage-documents, brokerage-quote-attachments  (bucket menu → "Empty bucket")
-- Supabase blocks deleting stored files with SQL, so this step is done in the dashboard.
-- =====================================================================================

-- STEP 0 (optional, read-only): preview what will be removed. Run this block alone first.
-- select 'super admins kept' as item, count(*) from public.profiles where role = 'SUPER_ADMIN'
-- union all select 'users removed', count(*) from public.profiles where role <> 'SUPER_ADMIN'
-- union all select 'departments kept', count(*) from public.departments
-- union all select 'leads removed', count(*) from public.sales_leads
-- union all select 'shipments removed', count(*) from public.brokerage_shipments
-- union all select 'invoices removed', count(*) from public.brokerage_invoices;

begin;

-- 1. Safety check: stop if there is no Super Admin to keep.
do $$
begin
  if not exists (select 1 from public.profiles p join auth.users u on u.id = p.id where p.role = 'SUPER_ADMIN' and p.is_active) then
    raise exception 'Aborted: no active Super Admin with a login was found. Nothing was changed.';
  end if;
end $$;

-- 2. All business and test data. CASCADE also clears any table that points at these.
truncate table
  public.dispatch_invoices,
  public.dispatch_loads,
  public.dispatch_activities,
  public.dispatch_carrier_documents,
  public.dispatch_trucks,
  public.dispatch_carriers,
  public.dispatch_targets,
  public.notifications,
  public.audit_events,
  public.record_comments,
  public.lead_activities,
  public.quote_events,
  public.quote_attachments,
  public.shipment_events,
  public.shipment_documents,
  public.brokerage_invoices,
  public.brokerage_shipments,
  public.sales_quotes,
  public.brokerage_customers,
  public.sales_leads,
  public.payroll_lines,
  public.payroll_runs,
  public.compensation_settings,
  public.user_permissions,
  public.team_lead_permissions,
  public.team_members,
  public.teams
restart identity cascade;

-- 3. Every login except Super Admins. Profiles are removed with their login (on delete cascade);
--    the second statement catches any profile without a login.
delete from auth.users
where id not in (select id from public.profiles where role = 'SUPER_ADMIN');

delete from public.profiles
where role <> 'SUPER_ADMIN';

-- 4. Departments are left exactly as they are.

-- 5. Final check before committing: only Super Admins remain.
do $$
begin
  if exists (select 1 from public.profiles where role <> 'SUPER_ADMIN') then
    raise exception 'Aborted: non Super Admin profiles still exist. Nothing was changed.';
  end if;
end $$;

commit;

-- 6. Verification (read-only). Expect: Super Admins only, departments unchanged, 0 everywhere else.
select 'profiles' as table_name, count(*) as rows from public.profiles
union all select 'auth users', count(*) from auth.users
union all select 'departments', count(*) from public.departments
union all select 'sales_leads', count(*) from public.sales_leads
union all select 'brokerage_customers', count(*) from public.brokerage_customers
union all select 'sales_quotes', count(*) from public.sales_quotes
union all select 'brokerage_shipments', count(*) from public.brokerage_shipments
union all select 'brokerage_invoices', count(*) from public.brokerage_invoices
union all select 'teams', count(*) from public.teams
union all select 'notifications', count(*) from public.notifications
union all select 'audit_events', count(*) from public.audit_events
union all select 'payroll_runs', count(*) from public.payroll_runs;
