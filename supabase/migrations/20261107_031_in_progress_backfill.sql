-- DEBOSS GLOBAL: loads already with Operations but without a carrier and carrier rate move to "In progress".
-- Run after 20261107_030_in_progress_and_contact_phones.sql, as a separate step. Safe to re-run.

update public.brokerage_shipments
set status = 'IN_PROGRESS'
where status = 'BOOKED'
  and operations_department_id is not null
  and (coalesce(trim(carrier_name), '') = '' or carrier_rate is null);

-- Loads waiting for the Operations Manager's review are In progress too.
update public.brokerage_shipments
set status = 'IN_PROGRESS'
where ops_review = 'PENDING' and status = 'QUOTED';
