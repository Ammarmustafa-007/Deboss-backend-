-- =====================================================================================
-- DEBOSS GLOBAL: clear the HR and payroll test data (run by hand in the Supabase SQL editor)
--
-- It DELETES every row of:
--   * attendance_records, department_costs, payroll_months
--   * payroll_runs and payroll_lines (finalized months)
--   * employee_records (base salaries, joining dates, exits, managers)
--   * ownership_transfers (customer handover history)
--   * audit history of HR and payroll changes only
-- and puts the commission rules back to the client's document.
--
-- It KEEPS: all users and logins, departments, and all Brokerage, Dispatch, Fronter and Chat data.
-- Real salaries or exits entered before running this are deleted too, so run it BEFORE entering real pay data.
-- Everything runs in ONE transaction: if anything fails, nothing is changed.
-- =====================================================================================

begin;

delete from public.attendance_records;
delete from public.department_costs;
delete from public.payroll_months;
delete from public.payroll_lines;
delete from public.payroll_runs;
delete from public.employee_records;
delete from public.ownership_transfers;

delete from public.audit_events where action in (
  'HR_RULES_UPDATED', 'EMPLOYEE_PAY_UPDATED', 'EMPLOYEE_EXIT_RECORDED', 'EMPLOYEE_EXIT_CANCELLED', 'ATTENDANCE_UPDATED',
  'COST_ADDED', 'COST_UPDATED', 'COST_REMOVED', 'PAYROLL_RATE_UPDATED', 'PAYROLL_FINALIZED', 'PAYROLL_REOPENED'
);

update public.hr_settings set updated_by = null, updated_at = now(), rules = '{
  "dispatch_sales": { "min_active_sales": 2, "rate": 5 },
  "dispatcher": { "tiers": [{ "from": 1500, "rate": 8 }, { "from": 2500, "rate": 10 }, { "from": 3500, "rate": 12 }] },
  "brokerage_sales": { "tiers": [{ "from": 2500, "rate": 8 }, { "from": 3500, "rate": 10 }, { "from": 4500, "rate": 12 }] },
  "brokerage_operations": { "tiers": [{ "from": 4000, "rate": 8 }, { "from": 5000, "rate": 10 }, { "from": 7000, "rate": 12 }] },
  "fronter_per_lead_pkr": 1000,
  "manager_share": { "DISPATCH_SALES_MANAGER": 25, "DISPATCH_MANAGER": 40, "BROKERAGE_SALES_MANAGER": 10, "BROKERAGE_OPERATIONS_MANAGER": 10 },
  "paid_leaves_per_month": 1
}'::jsonb;

commit;

-- Verification (read-only). Expect 0 on every row.
select 'attendance' as item, count(*) from public.attendance_records
union all select 'costs', count(*) from public.department_costs
union all select 'monthly rates', count(*) from public.payroll_months
union all select 'finalized months', count(*) from public.payroll_runs
union all select 'payroll lines', count(*) from public.payroll_lines
union all select 'employee records', count(*) from public.employee_records
union all select 'customer handovers', count(*) from public.ownership_transfers;
