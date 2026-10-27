-- DEBOSS GLOBAL: private Realtime channels for the chat typing indicator.
-- Run after 20261027_016_chat_and_fronters.sql. Safe to re-run.
--
-- The typing indicator travels on a Realtime broadcast channel named "typing:<conversation id>". As a public channel,
-- anyone signed in who knew a conversation id could join it and see who is typing (never message text). These policies
-- make it a private channel: only members of that conversation can join, hear or send typing events.

-- Is the signed-in user a member of the conversation named in a "typing:<uuid>" topic?
create or replace function public.chat_typing_member(topic text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if topic is null or topic !~ '^typing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return exists (select 1 from public.chat_members where conversation_id = split_part(topic, ':', 2)::uuid and user_id = auth.uid());
end; $$;
grant execute on function public.chat_typing_member(text) to authenticated;

drop policy if exists "chat members hear typing" on realtime.messages;
create policy "chat members hear typing" on realtime.messages for select to authenticated
  using (extension = 'broadcast' and public.chat_typing_member(realtime.topic()));

drop policy if exists "chat members send typing" on realtime.messages;
create policy "chat members send typing" on realtime.messages for insert to authenticated
  with check (extension = 'broadcast' and public.chat_typing_member(realtime.topic()));
