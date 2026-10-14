-- DEBOSS GLOBAL: Brokerage workflow completion.
-- Run after 20261013_003_brokerage_module.sql.

create table public.brokerage_customers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid unique references public.sales_leads(id) on delete set null,
  sales_department_id uuid not null references public.departments(id),
  owner_id uuid not null references public.profiles(id),
  company_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.brokerage_shipments(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('ASSIGNED', 'STATUS_CHANGED', 'EXCEPTION_RAISED', 'EXCEPTION_RESOLVED', 'INVOICE_READY', 'NOTE')),
  body text,
  from_status public.shipment_stage,
  to_status public.shipment_stage,
  created_at timestamptz not null default now()
);

create index brokerage_customers_scope_idx on public.brokerage_customers(sales_department_id, owner_id);
create index shipment_events_shipment_idx on public.shipment_events(shipment_id, created_at desc);

create trigger brokerage_customers_touch_updated_at before update on public.brokerage_customers for each row execute function public.touch_updated_at();

alter table public.brokerage_customers enable row level security;
alter table public.shipment_events enable row level security;

