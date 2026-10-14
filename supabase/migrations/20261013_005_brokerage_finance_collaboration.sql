-- DEBOSS GLOBAL: Brokerage completion - finance, collaboration, and documents.
-- Run after 20261013_004_brokerage_workflows.sql.

do $$
begin
  create type public.invoice_status as enum ('DRAFT', 'SENT', 'PENDING', 'PAID', 'OVERDUE', 'CANCELLED');
exception
  when duplicate_object then null;
end $$;

alter table public.brokerage_shipments
  add column if not exists amount_quoted numeric(12,2),
  add column if not exists amount_invoiced numeric(12,2),
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists payment_status public.invoice_status not null default 'DRAFT',
  add column if not exists pickup_date date,
  add column if not exists delivery_date date;

create table if not exists public.brokerage_invoices (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null unique references public.brokerage_shipments(id) on delete cascade,
  customer_id uuid references public.brokerage_customers(id) on delete set null,
  department_id uuid not null references public.departments(id),
  invoice_number text not null unique,
  amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  status public.invoice_status not null default 'DRAFT',
  due_date date,
  issued_at timestamptz,
  paid_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.record_comments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('LEAD', 'CUSTOMER', 'QUOTE', 'SHIPMENT', 'INVOICE')),
  entity_id uuid not null,
  author_id uuid not null references public.profiles(id),
  body text not null check (char_length(trim(body)) between 1 and 3000),
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists brokerage_invoices_department_status_idx on public.brokerage_invoices(department_id, status, due_date);
create index if not exists record_comments_entity_idx on public.record_comments(entity_type, entity_id, created_at);
create index if not exists notifications_recipient_idx on public.notifications(recipient_id, read_at, created_at desc);
drop trigger if exists brokerage_invoices_touch_updated_at on public.brokerage_invoices;
create trigger brokerage_invoices_touch_updated_at before update on public.brokerage_invoices for each row execute function public.touch_updated_at();

alter table public.brokerage_invoices enable row level security;
alter table public.record_comments enable row level security;
alter table public.notifications enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brokerage-documents', 'brokerage-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
