-- DEBOSS GLOBAL: HR and compensation rules (client document "DEBOSS HR and Compensation Rules").
-- Run after 20261028_023_channels_and_load_statuses.sql. Safe to re-run. Only adds tables and columns: no existing
-- user, load, invoice or finalized payroll is changed.
--
--   * hr_settings: every amount, percentage and target, changed only by the Super Admin
--   * employee_records: each person's base salary (PKR), joining date and exit
--   * attendance_records: Leave or Absent per working day (no row means Present)
--   * payroll_months: the USD to PKR rate entered for each month
--   * department_costs: monthly costs, with one of the four cost types
--   * ownership_transfers: who a customer belonged to before it was reassigned, so a leaver keeps the credit they earned
--   * payroll_lines.detail: the frozen payslip figures of a finalized month
--
-- All of these are read and written only through the API (service role), so no browser policies are added.

create table if not exists public.hr_settings (
  id boolean primary key default true check (id),
  rules jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.hr_settings enable row level security;

insert into public.hr_settings (rules) values ('{
  "dispatch_sales": { "min_active_sales": 2, "rate": 5 },
  "dispatcher": { "tiers": [{ "from": 1500, "rate": 8 }, { "from": 2500, "rate": 10 }, { "from": 3500, "rate": 12 }] },
  "brokerage_sales": { "tiers": [{ "from": 2500, "rate": 8 }, { "from": 3500, "rate": 10 }, { "from": 4500, "rate": 12 }] },
  "brokerage_operations": { "tiers": [{ "from": 4000, "rate": 8 }, { "from": 5000, "rate": 10 }, { "from": 7000, "rate": 12 }] },
  "fronter_per_lead_pkr": 1000,
  "manager_share": { "DISPATCH_SALES_MANAGER": 25, "DISPATCH_MANAGER": 40, "BROKERAGE_SALES_MANAGER": 10, "BROKERAGE_OPERATIONS_MANAGER": 10 },
  "paid_leaves_per_month": 1
}'::jsonb) on conflict (id) do nothing;

create table if not exists public.employee_records (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  base_salary_pkr numeric(12,2) not null default 0 check (base_salary_pkr >= 0),
  joined_on date,
  last_working_day date,
  exit_type text check (exit_type is null or exit_type in ('NOTICE_SERVED', 'NO_NOTICE', 'FIRED')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint employee_exit_complete check ((last_working_day is null) = (exit_type is null))
);
create index if not exists employee_records_exit_idx on public.employee_records(last_working_day) where last_working_day is not null;
alter table public.employee_records enable row level security;

create table if not exists public.attendance_records (
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null check (extract(isodow from work_date) between 1 and 5),
  status text not null check (status in ('LEAVE', 'ABSENT')),
  recorded_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, work_date)
);
create index if not exists attendance_records_date_idx on public.attendance_records(work_date);
alter table public.attendance_records enable row level security;

create table if not exists public.payroll_months (
  period date primary key check (extract(day from period) = 1),
  usd_to_pkr numeric(10,4) not null check (usd_to_pkr > 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.payroll_months enable row level security;

create table if not exists public.department_costs (
  id uuid primary key default gen_random_uuid(),
  period date not null check (extract(day from period) = 1),
  name text not null check (char_length(trim(name)) between 1 and 120),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'USD' check (currency in ('USD', 'PKR')),
  cost_type text not null check (cost_type in ('COMPANY_SHARED', 'ONE_DEPARTMENT', 'TWO_DEPARTMENTS', 'COMPANY_ONLY')),
  department_ids uuid[] not null default '{}',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint department_costs_shape check (
    (cost_type = 'ONE_DEPARTMENT' and cardinality(department_ids) = 1)
    or (cost_type = 'TWO_DEPARTMENTS' and cardinality(department_ids) = 2)
    or (cost_type in ('COMPANY_SHARED', 'COMPANY_ONLY') and cardinality(department_ids) = 0))
);
create index if not exists department_costs_period_idx on public.department_costs(period);
alter table public.department_costs enable row level security;

create table if not exists public.ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.brokerage_customers(id) on delete cascade,
  from_user uuid not null references public.profiles(id),
  to_user uuid not null references public.profiles(id),
  transferred_at timestamptz not null default now()
);
create index if not exists ownership_transfers_customer_idx on public.ownership_transfers(customer_id, transferred_at);
alter table public.ownership_transfers enable row level security;

alter table public.payroll_lines add column if not exists detail jsonb;
alter table public.payroll_runs add column if not exists usd_to_pkr numeric(10,4);
