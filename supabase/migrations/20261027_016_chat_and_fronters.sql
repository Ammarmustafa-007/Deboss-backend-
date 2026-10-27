-- DEBOSS GLOBAL: Chat module and Fronters (lead mining) module.
-- Run after 20261021_015_dispatch_module.sql. Safe to re-run. Adds new tables/values only.
--
-- Chat: direct messages (manager <-> manager, agent <-> manager; never agent <-> agent) and one group per team
-- (created from the team form; the manager is the group admin; nobody leaves; no edit/delete of messages).
-- Messages are sent and received live through Supabase Realtime, guarded by row-level security.
--
-- Fronters: a Brokerage function that mines raw prospects in a spreadsheet. A prospect marked Qualified becomes a
-- lead for the Brokerage Sales agent chosen in "Assign to"; only Sales converts leads to customers.

-- 1. Fronter is a third department function next to Sales and Operations.
alter type public.department_function add value if not exists 'FRONTER';

-- 2. Chat ---------------------------------------------------------------------------------------------------------
create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('DIRECT', 'GROUP')),
  team_id uuid unique references public.teams(id) on delete set null,
  name text check (name is null or char_length(trim(name)) between 2 and 80),
  photo_url text,
  direct_key text unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  constraint chat_direct_shape check ((kind = 'DIRECT' and direct_key is not null) or (kind = 'GROUP' and name is not null))
);

create table if not exists public.chat_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'MEMBER' check (role in ('ADMIN', 'MEMBER')),
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members(user_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_conversation_idx on public.chat_messages(conversation_id, created_at desc);

-- Who is in a conversation (security definer, so policies don't recurse into chat_members).
create or replace function public.is_chat_member(conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chat_members where conversation_id = conversation and user_id = auth.uid());
$$;

alter table public.chat_conversations enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "members read their conversations" on public.chat_conversations;
create policy "members read their conversations" on public.chat_conversations for select to authenticated using (public.is_chat_member(id));
drop policy if exists "members read members" on public.chat_members;
create policy "members read members" on public.chat_members for select to authenticated using (public.is_chat_member(conversation_id));
drop policy if exists "members read messages" on public.chat_messages;
create policy "members read messages" on public.chat_messages for select to authenticated using (public.is_chat_member(conversation_id));
-- Sending is direct from the browser for speed: only into your own conversations, only as yourself, only while active.
drop policy if exists "members send messages" on public.chat_messages;
create policy "members send messages" on public.chat_messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_chat_member(conversation_id)
    and exists (select 1 from public.profiles where id = auth.uid() and is_active));
-- No update or delete policies: messages can't be edited or deleted.

-- Keep the conversation's last activity current, and let people mark their own conversation as read.
create or replace function public.touch_chat_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.chat_conversations set last_message_at = new.created_at where id = new.conversation_id;
  update public.chat_members set last_read_at = new.created_at where conversation_id = new.conversation_id and user_id = new.sender_id;
  return new;
end; $$;
drop trigger if exists chat_messages_touch on public.chat_messages;
create trigger chat_messages_touch after insert on public.chat_messages for each row execute function public.touch_chat_conversation();

create or replace function public.mark_chat_read(conversation uuid)
returns void language sql security definer set search_path = public as $$
  update public.chat_members set last_read_at = now() where conversation_id = conversation and user_id = auth.uid();
$$;
-- Explicit table access for signed-in users (row-level security above still decides which rows), in case the
-- project doesn't grant new tables to the API roles automatically.
grant select on public.chat_conversations, public.chat_members to authenticated;
grant select, insert on public.chat_messages to authenticated;
grant execute on function public.mark_chat_read(uuid) to authenticated;
grant execute on function public.is_chat_member(uuid) to authenticated;

-- Live delivery.
do $$ begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null; end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-photos', 'chat-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 3. Fronters ------------------------------------------------------------------------------------------------------
create table if not exists public.fronter_prospects (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  created_by uuid not null references public.profiles(id),
  team_id uuid references public.teams(id) on delete set null,
  company_name text not null check (char_length(trim(company_name)) between 1 and 180),
  operator_name text, operator_number text, shipping_contact text, phone text, email text,
  truck_type text, load_type text check (load_type is null or load_type in ('FTL', 'LTL', 'BOTH')),
  shipping_volume text, commodity text, lanes text,
  physical_address text, other_locations text, billing_address text,
  billing_contact text, billing_phone text, billing_email text,
  payment_terms text, w9_received boolean not null default false, ein text,
  source text, website text, notes text,
  status text not null default 'NEW' check (status in ('NEW', 'CONTACTED', 'NOT_QUALIFIED', 'NOT_INTERESTED', 'QUALIFIED')),
  assigned_to uuid references public.profiles(id),
  lead_id uuid references public.sales_leads(id) on delete set null,
  qualified_by uuid references public.profiles(id),
  qualified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fronter_prospects_department_idx on public.fronter_prospects(department_id, status, updated_at desc);
create index if not exists fronter_prospects_creator_idx on public.fronter_prospects(created_by);
create index if not exists fronter_prospects_assigned_idx on public.fronter_prospects(assigned_to);

create table if not exists public.fronter_commodities (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  created_by uuid not null references public.profiles(id),
  commodity text not null check (char_length(trim(commodity)) between 1 and 160),
  trucks_used text, best_states text, notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fronter_commodities_department_idx on public.fronter_commodities(department_id);

-- A lead that came from a Fronter keeps the link, so Sales sees the mined details and reports give the Fronter credit.
alter table public.sales_leads add column if not exists fronter_prospect_id uuid references public.fronter_prospects(id) on delete set null;
create index if not exists sales_leads_fronter_idx on public.sales_leads(fronter_prospect_id);

drop trigger if exists fronter_prospects_touch on public.fronter_prospects;
create trigger fronter_prospects_touch before update on public.fronter_prospects for each row execute function public.touch_updated_at();
drop trigger if exists fronter_commodities_touch on public.fronter_commodities;
create trigger fronter_commodities_touch before update on public.fronter_commodities for each row execute function public.touch_updated_at();
alter table public.fronter_prospects enable row level security;
alter table public.fronter_commodities enable row level security;

-- 4. Team Lead rights and payroll roles for Fronters.
alter table public.team_lead_permissions drop constraint if exists team_lead_permissions_permission_key_check;
alter table public.team_lead_permissions add constraint team_lead_permissions_permission_key_check check (permission_key in (
  'sales.leads.view_team', 'sales.leads.edit_team', 'sales.leads.assign',
  'sales.activities.view_team', 'sales.activities.assign',
  'sales.quotes.view_team', 'sales.quotes.review', 'sales.quotes.handoff',
  'sales.reports.view_team',
  'operations.shipments.view_team', 'operations.shipments.assign', 'operations.shipments.update_team',
  'operations.documents.review', 'operations.exceptions.resolve', 'operations.billing.mark_invoice_ready',
  'operations.reports.view_team',
  'dispatch_sales.carriers.view_team', 'dispatch_sales.carriers.edit_team', 'dispatch_sales.carriers.assign',
  'dispatch_sales.carriers.review', 'dispatch_sales.invoices.signoff', 'dispatch_sales.reports.view_team',
  'dispatch.trucks.view_team', 'dispatch.trucks.update_team', 'dispatch.trucks.assign',
  'dispatch.invoices.review', 'dispatch.reports.view_team',
  'fronter.prospects.view_team', 'fronter.prospects.edit_team', 'fronter.prospects.qualify', 'fronter.reports.view_team'
));

alter table public.compensation_settings drop constraint if exists compensation_settings_role_key_check;
alter table public.compensation_settings add constraint compensation_settings_role_key_check check (role_key in (
  'BROKERAGE_SALES_AGENT', 'BROKERAGE_SALES_MANAGER', 'BROKERAGE_OPERATIONS_AGENT', 'BROKERAGE_OPERATIONS_MANAGER',
  'BROKERAGE_FRONTER_AGENT', 'BROKERAGE_FRONTER_MANAGER',
  'DISPATCH_SALES_AGENT', 'DISPATCH_SALES_MANAGER', 'DISPATCHER', 'DISPATCH_MANAGER'
));

-- 5. Every existing team gets its group (named after the team; manager is admin). New teams get one from the team form.
insert into public.chat_conversations (kind, team_id, name, created_by, created_at)
select 'GROUP', t.id, t.name, t.manager_id, now() from public.teams t
where not exists (select 1 from public.chat_conversations c where c.team_id = t.id);

insert into public.chat_members (conversation_id, user_id, role)
select c.id, people.user_id, case when people.user_id = t.manager_id then 'ADMIN' else 'MEMBER' end
from public.chat_conversations c
join public.teams t on t.id = c.team_id
join lateral (
  select tm.user_id from public.team_members tm where tm.team_id = t.id
  union select t.manager_id
  union select t.team_lead_id where t.team_lead_id is not null
) people on true
on conflict (conversation_id, user_id) do nothing;
