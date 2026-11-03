-- =====================================================================================
-- DEBOSS GLOBAL: remove the Chat / Fronter / Brokerage load test data from 27-28 Oct 2026 (run ONCE, by hand,
-- in the Supabase SQL editor)
--
-- It DELETES only what was created for testing:
--   * the departments TEST FRONTERS, TEST BROKERAGE SALES and TEST BROKERAGE OPERATIONS
--   * the test logins frmanager@test.com, fronter@test.com, tsmanager@test.com, tsagent@test.com,
--     tsopsmanager@test.com, tsopsagent@test.com
--   * test loads (shipments) with their quotes, documents, events and invoices
--   * their chats (direct messages and the test team group), mined prospects, commodities,
--     the leads / customer created from qualified test prospects, the test team,
--     notifications and audit history about all of the above
--
-- It KEEPS:
--   * every table, policy and setting from migrations 016 and 017 (Chat and Fronters stay ready to use)
--   * all other departments, users and data (Brokerage, Dispatch, the Super Admin)
--
-- Everything runs in ONE transaction, with safety checks: if anything looks wrong, nothing is changed.
-- Afterwards, delete the test group photo: Dashboard -> Storage -> chat-photos -> remove its folder(s).
-- =====================================================================================

-- STEP 0 (optional, read-only): preview. Run this block alone first.
-- with u as (select id from auth.users where email in ('frmanager@test.com', 'fronter@test.com', 'tsmanager@test.com', 'tsagent@test.com', 'tsopsmanager@test.com', 'tsopsagent@test.com')),
--      d as (select id from public.departments where name in ('TEST FRONTERS', 'TEST BROKERAGE SALES', 'TEST BROKERAGE OPERATIONS'))
-- select 'test users' as item, count(*) from u
-- union all select 'test departments', count(*) from d
-- union all select 'other people in test departments (must be 0)', count(*) from public.profiles where department_id in (select id from d) and id not in (select id from u)
-- union all select 'test chats', count(distinct conversation_id) from public.chat_members where user_id in (select id from u)
-- union all select 'chat messages', count(*) from public.chat_messages where sender_id in (select id from u)
-- union all select 'mined prospects', count(*) from public.fronter_prospects where department_id in (select id from d)
-- union all select 'leads', count(*) from public.sales_leads where department_id in (select id from d)
-- union all select 'customers', count(*) from public.brokerage_customers where sales_department_id in (select id from d);

begin;

create temporary table test_users on commit drop as
select id from auth.users where email in ('frmanager@test.com', 'fronter@test.com', 'tsmanager@test.com', 'tsagent@test.com', 'tsopsmanager@test.com', 'tsopsagent@test.com');

create temporary table test_departments on commit drop as
select id from public.departments where name in ('TEST FRONTERS', 'TEST BROKERAGE SALES', 'TEST BROKERAGE OPERATIONS');

-- Safety: only the test users may sit in the test departments, and no real person may be in a test chat.
do $$
begin
  if exists (select 1 from public.profiles where department_id in (select id from test_departments) and id not in (select id from test_users)) then
    raise exception 'Aborted: someone other than the test users is in a test department. Nothing was changed.';
  end if;
  if exists (select 1 from test_users join public.profiles p using (id) where p.role = 'SUPER_ADMIN') then
    raise exception 'Aborted: a test email belongs to a Super Admin. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.chat_members m
    join public.chat_conversations c on c.id = m.conversation_id and c.kind <> 'CHANNEL'
    where m.conversation_id in (select conversation_id from public.chat_members where user_id in (select id from test_users))
      and m.user_id not in (select id from test_users)
  ) then
    raise exception 'Aborted: a real user is in one of the test chats. Nothing was changed.';
  end if;
end $$;

-- Direct messages and team groups only: company channels (Quotes, Updates, Announcements) belong to everyone.
create temporary table test_conversations on commit drop as
select distinct m.conversation_id as id from public.chat_members m join public.chat_conversations c on c.id = m.conversation_id and c.kind <> 'CHANNEL'
where m.user_id in (select id from test_users)
union select id from public.chat_conversations where team_id in (select id from public.teams where department_id in (select id from test_departments));

create temporary table test_leads on commit drop as
select id from public.sales_leads where department_id in (select id from test_departments) or owner_id in (select id from test_users);

create temporary table test_customers on commit drop as
select id from public.brokerage_customers where sales_department_id in (select id from test_departments) or owner_id in (select id from test_users) or lead_id in (select id from test_leads);

create temporary table test_prospects on commit drop as
select id from public.fronter_prospects where department_id in (select id from test_departments) or created_by in (select id from test_users);

create temporary table test_teams on commit drop as
select id from public.teams where department_id in (select id from test_departments);

-- 1. Chats (members and messages go with their conversation); in channels, only the test users' own posts and seats.
delete from public.chat_conversations where id in (select id from test_conversations);
delete from public.chat_messages where sender_id in (select id from test_users);
delete from public.chat_members where user_id in (select id from test_users);

-- 2. Notifications and comments about test records, or sent to / written by test users.
delete from public.notifications
where recipient_id in (select id from test_users)
   or entity_id in (select id from test_leads union all select id from test_customers union all select id from test_prospects);
delete from public.record_comments
where author_id in (select id from test_users)
   or entity_id in (select id from test_leads union all select id from test_customers);

-- 3. Loads of test customers or test departments (documents and events go with them; invoices first).
create temporary table test_shipments on commit drop as
select id from public.brokerage_shipments
where customer_id in (select id from test_customers) or sales_department_id in (select id from test_departments) or operations_department_id in (select id from test_departments);
delete from public.notifications where entity_id in (select id from test_shipments);
delete from public.record_comments where entity_id in (select id from test_shipments);
delete from public.brokerage_invoices where shipment_id in (select id from test_shipments);
delete from public.shipment_documents where shipment_id in (select id from test_shipments);
delete from public.shipment_events where shipment_id in (select id from test_shipments);
delete from public.brokerage_shipments where id in (select id from test_shipments);
delete from public.quote_attachments where quote_id in (select id from public.sales_quotes where lead_id in (select id from test_leads));
delete from public.quote_events where quote_id in (select id from public.sales_quotes where lead_id in (select id from test_leads));
delete from public.sales_quotes where lead_id in (select id from test_leads);

-- 3b. Sales side: customer, then leads (their activities go with them), then the mined prospects.
delete from public.brokerage_customers where id in (select id from test_customers);
delete from public.lead_activities where lead_id in (select id from test_leads) or author_id in (select id from test_users);
delete from public.sales_leads where id in (select id from test_leads);
delete from public.fronter_prospects where id in (select id from test_prospects);
delete from public.fronter_commodities where department_id in (select id from test_departments) or created_by in (select id from test_users);

-- 4. The test team (members and Team Lead rights go with it) and anything else pointing at a test user.
delete from public.teams where id in (select id from test_teams);
delete from public.team_members where user_id in (select id from test_users);
delete from public.team_lead_permissions where user_id in (select id from test_users) or granted_by in (select id from test_users);
delete from public.user_permissions where user_id in (select id from test_users) or granted_by in (select id from test_users) or department_id in (select id from test_departments);
update public.fronter_prospects set assigned_to = null where assigned_to in (select id from test_users);
update public.fronter_prospects set qualified_by = null where qualified_by in (select id from test_users);
delete from public.compensation_settings where user_id in (select id from test_users);
update public.compensation_settings set updated_by = null where updated_by in (select id from test_users);
delete from public.payroll_lines where user_id in (select id from test_users);

-- 5. Audit history about the test users, departments and records.
delete from public.audit_events
where actor_id in (select id from test_users)
   or entity_id in (
     select id from test_users union all select id from test_departments union all select id from test_leads
     union all select id from test_customers union all select id from test_prospects union all select id from test_teams
     union all select id from test_conversations union all select id from test_shipments
   );

-- 6. The test logins (profiles are removed with them), then the test departments.
delete from auth.users where id in (select id from test_users);
delete from public.profiles where id in (select id from test_users);
delete from public.departments where id in (select id from test_departments);

-- 7. Safety check before saving: the test data is gone and the Super Admin is still there.
do $$
begin
  if exists (select 1 from public.departments where name in ('TEST FRONTERS', 'TEST BROKERAGE SALES', 'TEST BROKERAGE OPERATIONS'))
     or exists (select 1 from auth.users where email in ('frmanager@test.com', 'fronter@test.com', 'tsmanager@test.com', 'tsagent@test.com', 'tsopsmanager@test.com', 'tsopsagent@test.com')) then
    raise exception 'Aborted: test departments or users remain. Nothing was changed.';
  end if;
  if not exists (select 1 from public.profiles where role = 'SUPER_ADMIN' and is_active) then
    raise exception 'Aborted: no active Super Admin. Nothing was changed.';
  end if;
end $$;

commit;

-- 8. Verification (read-only). Expect 0 for every "test" row; the other counts are your real data.
select 'test departments' as item, count(*) from public.departments where name in ('TEST FRONTERS', 'TEST BROKERAGE SALES', 'TEST BROKERAGE OPERATIONS')
union all select 'test logins', count(*) from auth.users where email in ('frmanager@test.com', 'fronter@test.com', 'tsmanager@test.com', 'tsagent@test.com', 'tsopsmanager@test.com', 'tsopsagent@test.com')
union all select 'chat conversations left', count(*) from public.chat_conversations
union all select 'mined prospects left', count(*) from public.fronter_prospects
union all select 'departments (kept)', count(*) from public.departments
union all select 'users (kept)', count(*) from public.profiles;
