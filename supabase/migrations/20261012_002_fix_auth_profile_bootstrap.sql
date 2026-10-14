-- Run this once if the first migration was already executed.
-- New Auth users are initially created without a department, then the protected API assigns role and department.
alter table public.profiles
drop constraint if exists department_required_for_non_admin;
