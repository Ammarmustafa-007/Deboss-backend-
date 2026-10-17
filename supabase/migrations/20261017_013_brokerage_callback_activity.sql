-- DEBOSS GLOBAL: allow "CALLBACK" as a Sales activity type (requirement BS-2).
alter table public.lead_activities drop constraint if exists lead_activities_activity_type_check;
alter table public.lead_activities
  add constraint lead_activities_activity_type_check
  check (activity_type in ('CALL', 'CALLBACK', 'EMAIL', 'NOTE', 'FOLLOW_UP', 'APPOINTMENT'));
