-- DEBOSS GLOBAL: let the Super Admin delete a user who has no work in the CRM. Run after 20261103_027_fronter_sales_agent.sql.
-- Safe to re-run. Deleting the login removes the profile and everything that only belongs to it (chat seats, team
-- seats, permissions, notifications, pay setup). A user who created leads, loads, messages, comments or audit history is
-- refused instead, so no record ever points at a missing person: deactivate them instead.

create or replace function public.delete_unused_user(target uuid)
returns text language plpgsql security definer set search_path = public, auth as $$
declare problem text;
begin
  begin
    delete from auth.users where id = target;
    if not found then return 'NOT_FOUND'; end if;
    return 'DELETED';
  exception when foreign_key_violation then
    get stacked diagnostics problem = MESSAGE_TEXT;
    return 'IN_USE:' || problem;
  end;
end $$;

revoke all on function public.delete_unused_user(uuid) from public, anon, authenticated;
grant execute on function public.delete_unused_user(uuid) to service_role;
