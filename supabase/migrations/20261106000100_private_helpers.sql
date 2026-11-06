-- Keep the membership helpers out of the public API (they're only used by access rules).
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.is_member(uuid) set schema private;
alter function public.is_owner(uuid) set schema private;
alter function public.is_member_path(text) set schema private;
revoke all on function private.is_member(uuid), private.is_owner(uuid), private.is_member_path(text) from public, anon;
grant execute on function private.is_member(uuid), private.is_owner(uuid), private.is_member_path(text) to authenticated;
