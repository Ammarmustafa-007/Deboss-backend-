-- Dispatch loads: add the "Picked up" status between Booked and Delivered.
-- Safe to run more than once; existing loads are not changed.
alter table public.dispatch_loads drop constraint if exists dispatch_loads_status_check;
alter table public.dispatch_loads add constraint dispatch_loads_status_check
  check (status in ('BOOKED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'));
