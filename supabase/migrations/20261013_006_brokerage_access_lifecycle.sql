-- DEBOSS GLOBAL: Brokerage access and lifecycle completion.
-- Run after 20261013_005_brokerage_finance_collaboration.sql.

alter table public.sales_leads add column if not exists archived_at timestamptz;
alter table public.sales_quotes add column if not exists rejection_note text;

create table if not exists public.user_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  permission_key text not null,
  granted_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, department_id, permission_key)
);

create index if not exists user_permissions_scope_idx on public.user_permissions(department_id, user_id);
create index if not exists sales_leads_follow_up_idx on public.sales_leads(department_id, next_follow_up_at) where archived_at is null;
alter table public.user_permissions enable row level security;
