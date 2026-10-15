-- DEBOSS GLOBAL: Brokerage Sales customer shipment workflow.
-- Run after 20261015_009_brokerage_sales_customer_shipments.sql.

alter table public.brokerage_shipments
  add column if not exists customer_id uuid references public.brokerage_customers(id) on delete set null,
  add column if not exists sales_status public.shipment_stage not null default 'QUOTED';

-- Backfill handoff-created shipments so existing customer history remains intact.
update public.brokerage_shipments shipment
set customer_id = customer.id
from public.sales_quotes quote
join public.brokerage_customers customer on customer.lead_id = quote.lead_id
where shipment.quote_id = quote.id
  and shipment.customer_id is null;

-- Existing Operations records were already commercially booked when they
-- entered execution. Reflect completed payment/delivery without changing the
-- Operations execution status that historical records depend on.
update public.brokerage_shipments
set sales_status = case
  when payment_status = 'PAID' then 'PAID'::public.shipment_stage
  when status in ('DELIVERED', 'COMPLETED') then 'DELIVERED'::public.shipment_stage
  else 'BOOKED'::public.shipment_stage
end
where sales_status = 'QUOTED';

create index if not exists brokerage_shipments_customer_created_idx
  on public.brokerage_shipments(customer_id, created_at desc);

create index if not exists brokerage_shipments_sales_status_idx
  on public.brokerage_shipments(sales_department_id, sales_status, updated_at desc);
