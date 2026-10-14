-- DEBOSS GLOBAL: one-time identity, Departments, and Users setup.
-- Safe to run once in Supabase SQL Editor. It may also be re-run safely.
-- Before running: create admin@debossglobal.com in Authentication > Users.

create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('SUPER_ADMIN', 'MANAGER', 'AGENT', 'STAFF');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.business_unit as enum ('BROKERAGE', 'DISPATCH');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.department_function as enum ('SALES', 'OPERATIONS');
exception when duplicate_object then null; end $$;

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  business_unit public.business_unit not null,
  function public.department_function not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'New team member' check (char_length(trim(full_name)) between 2 and 100),
  email text not null unique,
  role public.user_role not null default 'STAFF',
  department_id uuid references public.departments(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists departments_touch_updated_at on public.departments;
create trigger departments_touch_updated_at before update on public.departments for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'New team member'), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists auth_user_profile on auth.users;
create trigger auth_user_profile after insert on auth.users for each row execute function public.handle_new_user();

-- Repair profiles for any Auth users created before this migration was run.
insert into public.profiles (id, full_name, email)
select id, coalesce(nullif(raw_user_meta_data ->> 'full_name', ''), 'New team member'), email
from auth.users
on conflict (id) do update set email = excluded.email;

-- Bootstrap the known DEBOSS administrator if that Auth account already exists.
update public.profiles
set full_name = 'Super Admin', role = 'SUPER_ADMIN', department_id = null, is_active = true
where lower(email) = lower('admin@debossglobal.com');

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'SUPER_ADMIN' and is_active = true);
$$;

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists "authenticated users can view active departments" on public.departments;
create policy "authenticated users can view active departments" on public.departments for select to authenticated using (is_active = true or public.is_super_admin());
drop policy if exists "super admins manage departments" on public.departments;
create policy "super admins manage departments" on public.departments for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists "users view their profile" on public.profiles;
create policy "users view their profile" on public.profiles for select to authenticated using (id = auth.uid() or public.is_super_admin());
drop policy if exists "super admins manage profiles" on public.profiles;
create policy "super admins manage profiles" on public.profiles for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists "super admins view audit events" on public.audit_events;
create policy "super admins view audit events" on public.audit_events for select to authenticated using (public.is_super_admin());
