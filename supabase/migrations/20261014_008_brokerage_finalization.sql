-- DEBOSS GLOBAL: final Brokerage review and reporting metadata.
-- Run after 20261013_007_brokerage_completion.sql.

alter table public.shipment_documents
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

create index if not exists shipment_documents_review_idx
  on public.shipment_documents(shipment_id, is_verified, reviewed_at desc);

create index if not exists brokerage_shipments_operations_assignment_idx
  on public.brokerage_shipments(operations_department_id, assigned_to, team_id, status);

create index if not exists sales_leads_owner_updated_idx
  on public.sales_leads(department_id, owner_id, updated_at desc)
  where archived_at is null;
