-- DEBOSS GLOBAL: Brokerage Sales and Brokerage Operations
-- Run after 20261012_001_identity_departments.sql and 20261012_002_fix_auth_profile_bootstrap.sql.

create type public.lead_stage as enum ('NEW', 'CONTACTED', 'QUALIFIED', 'CUSTOMER', 'LOST');
create type public.quote_stage as enum ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'HANDED_OFF');
create type public.shipment_stage as enum ('BOOKED', 'CARRIER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'EXCEPTION');

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  manager_id uuid not null references public.profiles(id),
  team_lead_id uuid references public.profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, name)
);

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.team_lead_permissions (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null check (permission_key in (
    'sales.leads.view_team', 'sales.leads.edit_team', 'sales.leads.assign',
    'sales.activities.view_team', 'sales.activities.assign',
    'sales.quotes.view_team', 'sales.quotes.review', 'sales.quotes.handoff',
    'sales.reports.view_team',
    'operations.shipments.view_team', 'operations.shipments.assign', 'operations.shipments.update_team',
    'operations.documents.review', 'operations.exceptions.resolve', 'operations.billing.mark_invoice_ready',
    'operations.reports.view_team'
  )),
  granted_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id, permission_key)
);

create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  team_id uuid references public.teams(id) on delete set null,
  owner_id uuid not null references public.profiles(id),
  company_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  stage public.lead_stage not null default 'NEW',
  estimated_monthly_value numeric(12,2),
  next_follow_up_at timestamptz,
  source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  activity_type text not null check (activity_type in ('CALL', 'EMAIL', 'NOTE', 'FOLLOW_UP', 'APPOINTMENT')),
  body text not null,
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.sales_quotes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id),
  created_by uuid not null references public.profiles(id),
  pickup_location text not null,
  delivery_location text not null,
  equipment_type text,
  quoted_rate numeric(12,2),
  stage public.quote_stage not null default 'DRAFT',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.brokerage_shipments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid unique references public.sales_quotes(id),
  sales_department_id uuid not null references public.departments(id),
  operations_department_id uuid references public.departments(id),
  team_id uuid references public.teams(id) on delete set null,
  assigned_to uuid references public.profiles(id) on delete set null,
  reference_number text not null unique,
  customer_name text not null,
  pickup_location text not null,
  delivery_location text not null,
  equipment_type text,
  carrier_name text,
  status public.shipment_stage not null default 'BOOKED',
  invoice_ready boolean not null default false,
  exception_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shipment_documents (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.brokerage_shipments(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  document_type text not null check (document_type in ('BOL', 'POD', 'RATE_CONFIRMATION', 'INVOICE', 'OTHER')),
  storage_path text not null,
  is_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create index sales_leads_scope_idx on public.sales_leads(department_id, team_id, owner_id, stage);
create index brokerage_shipments_scope_idx on public.brokerage_shipments(operations_department_id, team_id, assigned_to, status);

create trigger teams_touch_updated_at before update on public.teams for each row execute function public.touch_updated_at();
create trigger sales_leads_touch_updated_at before update on public.sales_leads for each row execute function public.touch_updated_at();
create trigger sales_quotes_touch_updated_at before update on public.sales_quotes for each row execute function public.touch_updated_at();
create trigger brokerage_shipments_touch_updated_at before update on public.brokerage_shipments for each row execute function public.touch_updated_at();

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_lead_permissions enable row level security;
alter table public.sales_leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.sales_quotes enable row level security;
alter table public.brokerage_shipments enable row level security;
alter table public.shipment_documents enable row level security;

-- Brokerage records are served through the authenticated Node API. No browser-side table policy is granted.
