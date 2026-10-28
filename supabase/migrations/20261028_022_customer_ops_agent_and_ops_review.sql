-- DEBOSS GLOBAL: one Operations agent per customer, and the Operations Manager review.
-- Run after 20261028_021_move_lead_statuses.sql. Safe to re-run. Adds statuses and columns; sets each existing
-- customer's Operations agent from its latest handed-off load. Loads already in progress are not changed.
--
-- From the client's "Brokerage Flow and Scenarios" (v2, sections 2 and 7):
--   * A customer's first load: agreed rate -> Sales Manager approves (and picks the Operations department once) ->
--     Operations Manager approves and assigns an Operations agent, or rejects with a written reason. A rejection goes
--     back to the Sales Manager, who sends it back to the agent to fix or closes out that load.
--   * The cycle runs once per customer: later loads go straight to the customer's Operations agent.
--   * The Operations Manager can reassign the customer's agent at any time.

alter type public.quote_stage add value if not exists 'OPS_REVIEW' after 'APPROVED';
alter type public.quote_stage add value if not exists 'OPS_REJECTED' after 'OPS_REVIEW';

-- The customer's Operations department (picked once by the Sales Manager) and agent (assigned once by the Ops Manager).
alter table public.brokerage_customers
  add column if not exists operations_department_id uuid references public.departments(id) on delete set null,
  add column if not exists operations_agent_id uuid references public.profiles(id) on delete set null,
  add column if not exists operations_assigned_at timestamptz;

-- The Operations Manager's decision on a customer's first load.
alter table public.sales_quotes
  add column if not exists ops_rejection_note text,
  add column if not exists ops_reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists ops_reviewed_at timestamptz;

-- A load waiting for (or rejected at) the Operations Manager's review.
alter table public.brokerage_shipments
  add column if not exists ops_review text check (ops_review is null or ops_review in ('PENDING', 'REJECTED'));

-- Existing customers keep the agent (and department) of their latest handed-off load, so their next loads go straight
-- to that agent. Customers without one go through the one-time review on their next load.
with latest as (
  select distinct on (customer_id) customer_id, operations_department_id, assigned_to, updated_at
  from public.brokerage_shipments
  where customer_id is not null and operations_department_id is not null and assigned_to is not null
  order by customer_id, updated_at desc
)
update public.brokerage_customers c set
  operations_department_id = coalesce(c.operations_department_id, latest.operations_department_id),
  operations_agent_id = coalesce(c.operations_agent_id, latest.assigned_to),
  operations_assigned_at = coalesce(c.operations_assigned_at, latest.updated_at)
from latest
where latest.customer_id = c.id;
