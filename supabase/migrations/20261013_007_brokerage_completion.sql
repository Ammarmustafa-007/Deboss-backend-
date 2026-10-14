-- DEBOSS GLOBAL: final Brokerage lifecycle records.
-- Run after 20261013_006_brokerage_access_lifecycle.sql.

alter table public.brokerage_shipments
  add column if not exists exception_owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists exception_resolved_at timestamptz,
  add column if not exists exception_resolution text;

create table if not exists public.quote_attachments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.sales_quotes(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.sales_quotes(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  event_type text not null,
  body text,
  created_at timestamptz not null default now()
);

create index if not exists brokerage_shipments_exception_owner_idx on public.brokerage_shipments(exception_owner_id) where exception_note is not null;
create index if not exists quote_attachments_quote_idx on public.quote_attachments(quote_id, created_at desc);
create index if not exists quote_events_quote_idx on public.quote_events(quote_id, created_at desc);

alter table public.quote_attachments enable row level security;
alter table public.quote_events enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brokerage-quote-attachments', 'brokerage-quote-attachments', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
