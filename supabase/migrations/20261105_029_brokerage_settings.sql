-- DEBOSS GLOBAL: Super Admin switch for the Brokerage Sales Manager step. Run after 20261103_028_delete_unused_user.sql.
-- Safe to re-run.
--
-- sales_manager_approval = true (default): a new customer's first load goes to the Sales Manager, then Operations.
-- sales_manager_approval = false: the agent hands the first load straight to the Operations Manager, and an
-- Operations rejection goes straight back to the agent.
--
-- Read and written only through the API (service role), so no browser policies are added.
-- Until this runs the API treats the switch as on, so nothing changes.

create table if not exists public.brokerage_settings (
  id boolean primary key default true check (id),
  sales_manager_approval boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.brokerage_settings enable row level security;

insert into public.brokerage_settings (id) values (true) on conflict (id) do nothing;
