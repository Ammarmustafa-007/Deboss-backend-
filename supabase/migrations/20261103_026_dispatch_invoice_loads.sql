-- DEBOSS GLOBAL: Dispatch invoices built from chosen loads. Run after 20261031_025_employee_manager.sql. Safe to re-run.
-- Client feedback (Dispatch v1): the Dispatcher picks which loads go on an invoice, a truck can have several invoices
-- in the same week, loads can be added or removed later, and the Dispatch Manager can edit an invoice at any stage.
--
-- 1. A load belongs to at most one invoice. Deleting an invoice frees its loads.
-- 2. The one-invoice-per-truck-per-week rule is removed.
-- 3. Existing invoices keep the loads they were built from (same truck, same week).

alter table public.dispatch_loads add column if not exists invoice_id uuid references public.dispatch_invoices(id) on delete set null;
create index if not exists dispatch_loads_invoice_idx on public.dispatch_loads(invoice_id);

do $$
declare constraint_name text;
begin
  for constraint_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.dispatch_invoices'::regclass and c.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname) from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) = array['truck_id', 'week_start']
  loop
    execute format('alter table public.dispatch_invoices drop constraint %I', constraint_name);
  end loop;
end $$;
create index if not exists dispatch_invoices_truck_week_idx on public.dispatch_invoices(truck_id, week_start);

update public.dispatch_loads l set invoice_id = i.id
from public.dispatch_invoices i
where l.invoice_id is null and i.truck_id = l.truck_id and i.status <> 'CANCELLED' and l.status <> 'CANCELLED'
  and l.pickup_date between i.week_start and i.week_end;
