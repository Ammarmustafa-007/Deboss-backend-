-- DEBOSS GLOBAL: company chat channels, and the load statuses from the client's document.
-- Run after 20261028_022_customer_ops_agent_and_ops_review.sql. Safe to re-run.
--
-- 1. Load statuses (client flow v2, section 3.3): Booked -> Picked up -> Delivered -> Completed (when paid), plus
--    Missed pickup and Cancelled. Carrier assigned and In transit are retired; Exception becomes a flag on the load
--    (its note and resolution), so a load in Exception goes back to where it was and keeps the open exception.
-- 2. Chat channels (section 8): Quotes, Updates and Company announcements, next to direct messages and team groups.
--    Who is in a channel is kept in sync by the API; only managers and the Super Admin post announcements.
--    Key Brokerage events are posted into Quotes / Updates automatically (messages of kind EVENT).

-- 1. Live loads off the retired statuses ---------------------------------------------------------------------------
-- Exception: back to the step it was raised from (mapped to the new steps). The exception note stays open.
update public.brokerage_shipments s set status = case coalesce((
    select e.from_status::text from public.shipment_events e
    where e.shipment_id = s.id and e.to_status::text = 'EXCEPTION' and e.from_status is not null and e.from_status::text <> 'EXCEPTION'
    order by e.created_at desc limit 1), 'PICKED_UP')
  when 'CARRIER_ASSIGNED' then 'BOOKED' when 'IN_TRANSIT' then 'PICKED_UP' when 'BOOKED' then 'BOOKED'
  when 'PICKED_UP' then 'PICKED_UP' when 'DELIVERED' then 'DELIVERED' else 'PICKED_UP' end::public.shipment_stage
where s.status::text = 'EXCEPTION';
update public.brokerage_shipments set status = 'BOOKED' where status::text = 'CARRIER_ASSIGNED';
update public.brokerage_shipments set status = 'PICKED_UP' where status::text = 'IN_TRANSIT';

-- 2. Channels -----------------------------------------------------------------------------------------------------
alter table public.chat_conversations drop constraint if exists chat_conversations_kind_check;
alter table public.chat_conversations add constraint chat_conversations_kind_check check (kind in ('DIRECT', 'GROUP', 'CHANNEL'));
alter table public.chat_conversations add column if not exists channel_key text unique check (channel_key is null or channel_key in ('QUOTES', 'UPDATES', 'ANNOUNCEMENTS'));
alter table public.chat_conversations drop constraint if exists chat_direct_shape;
alter table public.chat_conversations add constraint chat_direct_shape check (
  (kind = 'DIRECT' and direct_key is not null) or (kind = 'GROUP' and name is not null) or (kind = 'CHANNEL' and name is not null and channel_key is not null));

insert into public.chat_conversations (kind, channel_key, name) values
  ('CHANNEL', 'QUOTES', 'Quotes'), ('CHANNEL', 'UPDATES', 'Updates'), ('CHANNEL', 'ANNOUNCEMENTS', 'Company announcements')
on conflict (channel_key) do nothing;

-- Messages people write are USER; EVENT messages are posted by the system (the API) and can't be written from the browser.
alter table public.chat_messages add column if not exists kind text not null default 'USER' check (kind in ('USER', 'EVENT'));

-- Who may write in a conversation: its members, as themselves, while active; announcements are for managers only.
create or replace function public.chat_can_post(conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_chat_member(conversation)
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
     and not exists (
       select 1 from public.chat_conversations c
       where c.id = conversation and c.channel_key = 'ANNOUNCEMENTS'
         and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('MANAGER', 'SUPER_ADMIN')));
$$;
grant execute on function public.chat_can_post(uuid) to authenticated;

drop policy if exists "members send messages" on public.chat_messages;
create policy "members send messages" on public.chat_messages for insert to authenticated
  with check (sender_id = auth.uid() and kind = 'USER' and public.chat_can_post(conversation_id));
