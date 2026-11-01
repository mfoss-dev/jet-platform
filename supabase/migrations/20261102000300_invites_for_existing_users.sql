-- Invites now work in either order: invite first then sign in (handled by private.handle_new_user),
-- or sign in first then invite (handled here). Also repairs sign-ins created before the profiles trigger existed.

create or replace function private.apply_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = new.email;
  if uid is null then
    return new;  -- not signed in yet: keep the invite for their first sign-in
  end if;
  insert into public.profiles (id, email, full_name, role, branch_code, customer_id)
  values (uid, new.email, new.full_name, new.role, new.branch_code, new.customer_id)
  on conflict (id) do update
    set full_name = excluded.full_name, role = excluded.role, branch_code = excluded.branch_code, customer_id = excluded.customer_id;
  return null;   -- applied straight away, so the invite row isn't kept
end $$;

create trigger user_invites_apply before insert on public.user_invites
  for each row execute function private.apply_invite();

-- One-off repair: anyone who signed in before this existed.
insert into public.profiles (id, email, full_name, role, branch_code, customer_id)
select u.id, lower(u.email), coalesce(i.full_name, ''), coalesce(i.role, 'customer_user'), i.branch_code, i.customer_id
from auth.users u
left join public.user_invites i on i.email = lower(u.email)
where u.email is not null
on conflict (id) do update
  set full_name = excluded.full_name, role = excluded.role, branch_code = excluded.branch_code, customer_id = excluded.customer_id
  where exists (select 1 from public.user_invites i2 where i2.email = excluded.email);

delete from public.user_invites i using auth.users u where i.email = lower(u.email);
