-- DEBOSS GLOBAL: activity completion state for Brokerage Sales follow-ups.
-- A null completed_at represents a pending activity; a timestamp represents
-- an explicitly completed call, callback, appointment, note, or email.

alter table public.lead_activities
  add column if not exists completed_at timestamptz;

create index if not exists lead_activities_lead_completion_idx
  on public.lead_activities(lead_id, completed_at, due_at);
