-- DEBOSS GLOBAL: compensation settings and monthly payroll (requirements PY-1 to PY-5, RP-1).
-- Run after 20261017_013_brokerage_callback_activity.sql.

-- Base salary and commission, either as a role default (role_key) or a personal override (user_id).
create table if not exists public.compensation_settings (
  id uuid primary key default gen_random_uuid(),
  role_key text check (role_key in ('BROKERAGE_SALES_AGENT', 'BROKERAGE_SALES_MANAGER', 'BROKERAGE_OPERATIONS_AGENT', 'BROKERAGE_OPERATIONS_MANAGER')),
  user_id uuid references public.profiles(id) on delete cascade,
  base_salary numeric(12,2) not null default 0 check (base_salary >= 0),
  commission_rate numeric(5,2) not null default 0 check (commission_rate >= 0 and commission_rate <= 100),
  commission_basis text not null default 'APPROVED_GROSS' check (commission_basis in ('APPROVED_GROSS', 'COLLECTED')),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  constraint compensation_settings_target check ((role_key is null) <> (user_id is null))
);
create unique index if not exists compensation_settings_role_idx on public.compensation_settings(role_key) where role_key is not null;
create unique index if not exists compensation_settings_user_idx on public.compensation_settings(user_id) where user_id is not null;

-- A finalized month. Months without a row are live drafts computed on request.
create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period date not null unique check (extract(day from period) = 1),
  finalized_by uuid not null references public.profiles(id),
  finalized_at timestamptz not null default now(),
  totals jsonb not null default '{}'::jsonb
);

-- Frozen per-person figures for a finalized month.
create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  full_name text not null,
  role_key text not null,
  department_id uuid references public.departments(id),
  department_name text,
  base_salary numeric(12,2) not null default 0,
  commission_basis text not null,
  commission_rate numeric(5,2) not null default 0,
  basis_amount numeric(14,2) not null default 0,
  commission_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  configured boolean not null default true,
  items jsonb not null default '[]'::jsonb,
  unique (run_id, user_id)
);
create index if not exists payroll_lines_user_idx on public.payroll_lines(user_id);

-- Salary data is visible only to the Director and the person it belongs to (NFR 4.2).
-- The API uses the service role; these policies cover any direct client access.
alter table public.compensation_settings enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_lines enable row level security;

drop policy if exists "super admins manage compensation" on public.compensation_settings;
create policy "super admins manage compensation" on public.compensation_settings for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists "users view their own compensation" on public.compensation_settings;
create policy "users view their own compensation" on public.compensation_settings for select to authenticated using (user_id = auth.uid());

drop policy if exists "super admins manage payroll runs" on public.payroll_runs;
create policy "super admins manage payroll runs" on public.payroll_runs for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists "super admins manage payroll lines" on public.payroll_lines;
create policy "super admins manage payroll lines" on public.payroll_lines for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists "users view their own payroll lines" on public.payroll_lines;
create policy "users view their own payroll lines" on public.payroll_lines for select to authenticated using (user_id = auth.uid());
