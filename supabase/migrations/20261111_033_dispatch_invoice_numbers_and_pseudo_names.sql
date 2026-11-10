-- DEBOSS GLOBAL: Dispatch invoices numbered from 01, and dispatchers' pseudo names. Run after 20261108_032_invoice_due_15_days.sql.
--
-- 1. profiles.pseudo_name: the name a dispatcher uses with carriers. Dispatch invoices (and their PDF, branded
--    Backend Solutions) show it instead of the person's real name. Set from the invoice drawer.
-- 2. Dispatch invoice numbers become a plain running number: 01, 02, 03... The API gives each new invoice the next
--    number; this renumbers the invoices that already exist, oldest first.
--    Re-running it renumbers in the same order, so the result is the same.

alter table public.profiles add column if not exists pseudo_name text check (pseudo_name is null or char_length(trim(pseudo_name)) between 2 and 100);

-- Renumber in two steps so no number collides with an existing one on the way.
with ordered as (select id, row_number() over (order by created_at, id) as n from public.dispatch_invoices)
update public.dispatch_invoices i set invoice_number = 'RENUMBER-' || o.n from ordered o where o.id = i.id;

update public.dispatch_invoices
set invoice_number = lpad(substring(invoice_number from 10), 2, '0')
where invoice_number like 'RENUMBER-%';
