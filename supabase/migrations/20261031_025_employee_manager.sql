-- DEBOSS GLOBAL: which manager an employee reports to. Run after 20261030_024_hr_payroll.sql. Safe to re-run.
-- Client decision: when a department has two managers, the profit and loss of each manager and their team is tracked
-- and calculated separately. Only needed in those departments; nothing existing is changed.

alter table public.employee_records add column if not exists manager_id uuid references public.profiles(id) on delete set null;
