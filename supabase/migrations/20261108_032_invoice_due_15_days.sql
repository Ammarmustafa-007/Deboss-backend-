-- DEBOSS GLOBAL: Brokerage invoices are due 15 days after the load's delivery date (client feedback).
-- Run after 20261107_031_in_progress_backfill.sql. Safe to re-run.
-- The API does this for new invoices (and when a delivery date changes); this corrects the invoices already issued.

update public.brokerage_invoices i
set due_date = s.delivery_date + 15
from public.brokerage_shipments s
where s.id = i.shipment_id
  and s.delivery_date is not null
  and i.status not in ('PAID', 'CANCELLED');

-- Anything unpaid that is now past its due date shows as overdue straight away (the API also checks every hour).
update public.brokerage_invoices
set status = 'OVERDUE'
where due_date < current_date
  and status in ('DRAFT', 'SENT', 'PENDING');
