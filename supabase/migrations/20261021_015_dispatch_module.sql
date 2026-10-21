-- DEBOSS GLOBAL: Dispatch module (client spec 3.4 Dispatch Sales, 3.5 Dispatch operations, 8.2 carrier/truck states).
-- Run after 20261017_014_payroll_compensation.sql. Safe to re-run. Adds new tables only; Brokerage data is untouched.
--
-- Flow: Dispatch Sales agent onboards a carrier (MC/DOT, documents, trucks) -> submits -> Dispatch Sales Manager
-- approves and hands it to Dispatch Operations -> Dispatch Manager assigns each truck to a Dispatcher -> the Dispatcher
-- logs every load and creates weekly invoices (gross x charge %) -> Dispatch Manager reviews and forwards -> paid ->
-- Dispatch Sales Manager signs off, which is what payroll counts.

-- 1. Departments: the operations side of Dispatch was created with a Sales-looking name. Give it its proper name.
update public.departments set name = 'DISPATCH OPERATIONS'
where business_unit = 'DISPATCH' and function = 'OPERATIONS' and upper(trim(name)) = 'DISPATCH SALES'
  and not exists (select 1 from public.departments where upper(trim(name)) = 'DISPATCH OPERATIONS');
update public.departments set name = 'DISPATCH SALES'
where business_unit = 'DISPATCH' and function = 'SALES' and name <> 'DISPATCH SALES' and upper(trim(name)) = 'DISPATCH SALES';

-- 2. Carriers (one MC/DOT company). A carrier is reviewed once; each of its trucks is a sale.
create table if not exists public.dispatch_carriers (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  owner_id uuid not null references public.profiles(id),
  team_id uuid references public.teams(id) on delete set null,
  company_name text not null check (char_length(trim(company_name)) between 2 and 180),
  mc_number text check (mc_number is null or char_length(trim(mc_number)) between 3 and 20),
  dot_number text check (dot_number is null or char_length(trim(dot_number)) between 3 and 20),
  contact_name text,
  phone text,
  email text,
  operating_pattern text,
  charge_percent numeric(5,2) check (charge_percent is null or (charge_percent >= 0 and charge_percent <= 100)),
  payment_method text check (payment_method is null or payment_method in ('ACH', 'CHECK', 'ZELLE', 'WIRE', 'FACTORING', 'OTHER')),
  review_status text not null default 'DOCS_PENDING' check (review_status in ('DOCS_PENDING', 'PENDING_REVIEW', 'RETURNED', 'APPROVED', 'DISCARDED')),
  review_note text,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  dispatch_department_id uuid references public.departments(id),
  handed_off_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatch_carriers_identity check (mc_number is not null or dot_number is not null)
);
create index if not exists dispatch_carriers_owner_idx on public.dispatch_carriers(owner_id, review_status);
create index if not exists dispatch_carriers_department_idx on public.dispatch_carriers(department_id, review_status, updated_at desc);
create index if not exists dispatch_carriers_mc_idx on public.dispatch_carriers(upper(mc_number));
create index if not exists dispatch_carriers_dot_idx on public.dispatch_carriers(upper(dot_number));

-- 3. Trucks: each one is a sale with its own lifecycle (Figure 5) and Dispatcher.
create table if not exists public.dispatch_trucks (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.dispatch_carriers(id) on delete cascade,
  unit_number text not null check (char_length(trim(unit_number)) between 1 and 40),
  truck_type text not null check (truck_type in ('DRY_VAN', 'REEFER', 'FLATBED', 'STEP_DECK', 'POWER_ONLY', 'BOX_TRUCK', 'HOTSHOT', 'OTHER')),
  equipment_notes text,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'ONBOARDED', 'RUNNING', 'INACTIVE', 'DNC', 'DISCARDED')),
  dispatch_department_id uuid references public.departments(id),
  assigned_to uuid references public.profiles(id),
  team_id uuid references public.teams(id) on delete set null,
  dnc_reason text,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dispatch_trucks_carrier_idx on public.dispatch_trucks(carrier_id);
create index if not exists dispatch_trucks_dispatch_idx on public.dispatch_trucks(dispatch_department_id, status);
create index if not exists dispatch_trucks_assigned_idx on public.dispatch_trucks(assigned_to, status);

-- 4. Carrier documents (DS-3), retained at least 3 years (4.6).
create table if not exists public.dispatch_carrier_documents (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.dispatch_carriers(id) on delete cascade,
  document_type text not null check (document_type in ('MC_AUTHORITY', 'W9', 'COI', 'PACKET', 'OTHER')),
  file_name text not null,
  storage_path text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists dispatch_carrier_documents_idx on public.dispatch_carrier_documents(carrier_id, created_at desc);

-- 5. Appointments, callbacks and follow-ups (DS-2).
create table if not exists public.dispatch_activities (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.dispatch_carriers(id) on delete cascade,
  activity_type text not null check (activity_type in ('CALL', 'CALLBACK', 'APPOINTMENT', 'FOLLOW_UP', 'EMAIL', 'NOTE')),
  body text not null check (char_length(trim(body)) between 1 and 3000),
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists dispatch_activities_idx on public.dispatch_activities(carrier_id, created_at desc);

-- 6. Loads: every load is entered (answer 3); weekly gross is their total.
create table if not exists public.dispatch_loads (
  id uuid primary key default gen_random_uuid(),
  truck_id uuid not null references public.dispatch_trucks(id) on delete cascade,
  dispatcher_id uuid not null references public.profiles(id),
  load_number text,
  broker_name text,
  pickup_city text,
  pickup_zip text,
  pickup_date date not null,
  delivery_city text,
  delivery_zip text,
  delivery_date date,
  rate numeric(12,2) not null check (rate >= 0),
  miles integer check (miles is null or miles >= 0),
  status text not null default 'BOOKED' check (status in ('BOOKED', 'DELIVERED', 'CANCELLED')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dispatch_loads_truck_idx on public.dispatch_loads(truck_id, pickup_date desc);
create index if not exists dispatch_loads_dispatcher_idx on public.dispatch_loads(dispatcher_id, pickup_date desc);
create index if not exists dispatch_loads_zip_idx on public.dispatch_loads(pickup_zip, delivery_zip);

-- 7. Weekly invoices per truck (DP-8, DS-12, answer 2): Dispatcher creates, Dispatch Manager reviews and forwards.
create table if not exists public.dispatch_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  truck_id uuid not null references public.dispatch_trucks(id),
  carrier_id uuid not null references public.dispatch_carriers(id),
  dispatcher_id uuid not null references public.profiles(id),
  dispatch_department_id uuid not null references public.departments(id),
  sales_department_id uuid not null references public.departments(id),
  sales_agent_id uuid references public.profiles(id),
  week_start date not null,
  week_end date not null,
  gross_amount numeric(12,2) not null default 0,
  charge_percent numeric(5,2) not null default 0,
  amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'FORWARDED', 'PAID', 'CANCELLED')),
  review_note text,
  due_date date,
  submitted_at timestamptz,
  forwarded_at timestamptz,
  forwarded_by uuid references public.profiles(id),
  paid_at timestamptz,
  signed_off_at timestamptz,
  signed_off_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (truck_id, week_start)
);
create index if not exists dispatch_invoices_department_idx on public.dispatch_invoices(dispatch_department_id, status, week_start desc);
create index if not exists dispatch_invoices_sales_idx on public.dispatch_invoices(sales_department_id, status, week_start desc);
create index if not exists dispatch_invoices_dispatcher_idx on public.dispatch_invoices(dispatcher_id, week_start desc);

-- 8. Weekly / monthly targets per agent or dispatcher (DS-11, DP-5).
create table if not exists public.dispatch_targets (
  user_id uuid not null references public.profiles(id) on delete cascade,
  period_type text not null check (period_type in ('WEEKLY', 'MONTHLY')),
  amount numeric(12,2) not null check (amount >= 0),
  set_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_type)
);

-- 9. Comments on Dispatch records (DS-8, DP-7) reuse the shared comment table.
alter table public.record_comments drop constraint if exists record_comments_entity_type_check;
alter table public.record_comments add constraint record_comments_entity_type_check
  check (entity_type in ('LEAD', 'CUSTOMER', 'QUOTE', 'SHIPMENT', 'INVOICE', 'CARRIER', 'TRUCK', 'DISPATCH_INVOICE'));

-- 10. Team Lead permissions for the Dispatch departments (answer 6).
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
  'dispatch.invoices.review', 'dispatch.reports.view_team'
));

-- 11. Payroll roles for Dispatch (PY-2).
alter table public.compensation_settings drop constraint if exists compensation_settings_role_key_check;
alter table public.compensation_settings add constraint compensation_settings_role_key_check check (role_key in (
  'BROKERAGE_SALES_AGENT', 'BROKERAGE_SALES_MANAGER', 'BROKERAGE_OPERATIONS_AGENT', 'BROKERAGE_OPERATIONS_MANAGER',
  'DISPATCH_SALES_AGENT', 'DISPATCH_SALES_MANAGER', 'DISPATCHER', 'DISPATCH_MANAGER'
));

-- 12. Housekeeping: updated_at triggers, row security (the API uses the service role), private document bucket.
drop trigger if exists dispatch_carriers_touch on public.dispatch_carriers;
create trigger dispatch_carriers_touch before update on public.dispatch_carriers for each row execute function public.touch_updated_at();
drop trigger if exists dispatch_trucks_touch on public.dispatch_trucks;
create trigger dispatch_trucks_touch before update on public.dispatch_trucks for each row execute function public.touch_updated_at();
drop trigger if exists dispatch_loads_touch on public.dispatch_loads;
create trigger dispatch_loads_touch before update on public.dispatch_loads for each row execute function public.touch_updated_at();
drop trigger if exists dispatch_invoices_touch on public.dispatch_invoices;
create trigger dispatch_invoices_touch before update on public.dispatch_invoices for each row execute function public.touch_updated_at();

alter table public.dispatch_carriers enable row level security;
alter table public.dispatch_trucks enable row level security;
alter table public.dispatch_carrier_documents enable row level security;
alter table public.dispatch_activities enable row level security;
alter table public.dispatch_loads enable row level security;
alter table public.dispatch_invoices enable row level security;
alter table public.dispatch_targets enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dispatch-documents', 'dispatch-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
