-- =====================================================================================
-- DEBOSS GLOBAL: Dispatch reset (run ONCE, by hand, in the Supabase SQL editor)
--
-- Removes all Dispatch test data and every user in a Dispatch department, so the client
-- starts the Dispatch module clean. It KEEPS:
--   * the Dispatch departments (DISPATCH SALES, DISPATCH OPERATIONS) and all departments
--   * everything in Brokerage (users, leads, shipments, invoices, teams, payroll)
--   * the Super Admin
--   * every table and setting (the schema is untouched)
--
-- It DELETES:
--   * carriers, trucks, carrier documents, activities, loads, weekly invoices, targets
--   * comments and notifications about Dispatch records
--   * Dispatch teams and their Team Lead rights
--   * every user (login + profile) whose department is a Dispatch department
--
-- Everything runs in ONE transaction: if anything fails, nothing is changed.
-- Afterwards, empty the "dispatch-documents" bucket in Dashboard -> Storage.
-- =====================================================================================

-- STEP 0 (optional, read-only): preview. Run this block alone first.
-- select 'dispatch users removed' as item, count(*) from public.profiles p join public.departments d on d.id = p.department_id where d.business_unit = 'DISPATCH' and p.role <> 'SUPER_ADMIN'
-- union all select 'carriers removed', count(*) from public.dispatch_carriers
-- union all select 'trucks removed', count(*) from public.dispatch_trucks
-- union all select 'loads removed', count(*) from public.dispatch_loads
-- union all select 'weekly invoices removed', count(*) from public.dispatch_invoices
-- union all select 'dispatch teams removed', count(*) from public.teams t join public.departments d on d.id = t.department_id where d.business_unit = 'DISPATCH'
-- union all select 'departments kept', count(*) from public.departments;

begin;

-- The Dispatch users to remove (never a Super Admin).
create temporary table dispatch_users on commit drop as
select p.id from public.profiles p
join public.departments d on d.id = p.department_id
where d.business_unit = 'DISPATCH' and p.role <> 'SUPER_ADMIN';

-- 1. Dispatch records (children first).
delete from public.dispatch_invoices;
delete from public.dispatch_loads;
delete from public.dispatch_activities;
delete from public.dispatch_carrier_documents;
delete from public.dispatch_trucks;
delete from public.dispatch_carriers;
delete from public.dispatch_targets;

-- 2. Comments and notifications about Dispatch records, and anything written by or sent to Dispatch users.
delete from public.record_comments where entity_type in ('CARRIER', 'TRUCK', 'DISPATCH_INVOICE') or author_id in (select id from dispatch_users);
delete from public.notifications where entity_type in ('CARRIER', 'TRUCK', 'DISPATCH_INVOICE') or recipient_id in (select id from dispatch_users);

-- 3. Dispatch audit history (Brokerage history is kept).
delete from public.audit_events where entity_type in ('dispatch_carrier', 'dispatch_truck', 'dispatch_load', 'dispatch_invoice', 'carrier', 'truck');

-- 4. Dispatch teams (members and Team Lead rights go with them).
delete from public.teams where department_id in (select id from public.departments where business_unit = 'DISPATCH');

-- 5. Anything else that still points at a Dispatch user.
delete from public.team_members where user_id in (select id from dispatch_users);
delete from public.team_lead_permissions where user_id in (select id from dispatch_users) or granted_by in (select id from dispatch_users);
delete from public.compensation_settings where user_id in (select id from dispatch_users);
update public.compensation_settings set updated_by = null where updated_by in (select id from dispatch_users);
delete from public.payroll_lines where user_id in (select id from dispatch_users);
delete from public.user_permissions where user_id in (select id from dispatch_users);
update public.audit_events set actor_id = null where actor_id in (select id from dispatch_users);

-- 6. The Dispatch users themselves (profiles are removed with their login).
delete from auth.users where id in (select id from dispatch_users);
delete from public.profiles where id in (select id from dispatch_users);

-- 7. Safety check before saving: Dispatch is empty, departments and the Super Admin are still there.
do $$
begin
  if exists (select 1 from public.dispatch_carriers) or exists (select 1 from public.dispatch_trucks) then
    raise exception 'Aborted: Dispatch records remain. Nothing was changed.';
  end if;
  if not exists (select 1 from public.departments where business_unit = 'DISPATCH') then
    raise exception 'Aborted: Dispatch departments are missing. Nothing was changed.';
  end if;
  if not exists (select 1 from public.profiles where role = 'SUPER_ADMIN' and is_active) then
    raise exception 'Aborted: no active Super Admin. Nothing was changed.';
  end if;
end $$;

commit;

-- 8. Verification (read-only). Expect 0 Dispatch rows and 0 Dispatch users; departments unchanged.
select 'dispatch users' as item, count(*) from public.profiles p join public.departments d on d.id = p.department_id where d.business_unit = 'DISPATCH'
union all select 'carriers', count(*) from public.dispatch_carriers
union all select 'trucks', count(*) from public.dispatch_trucks
union all select 'loads', count(*) from public.dispatch_loads
union all select 'weekly invoices', count(*) from public.dispatch_invoices
union all select 'dispatch departments', count(*) from public.departments where business_unit = 'DISPATCH'
union all select 'brokerage users (kept)', count(*) from public.profiles p join public.departments d on d.id = p.department_id where d.business_unit = 'BROKERAGE';
