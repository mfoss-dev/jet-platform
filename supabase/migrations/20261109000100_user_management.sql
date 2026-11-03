-- User management from the screens: Users & roles (Jet) and Account & users (customer admins).
-- Who may do what:
--   * owner, admin: anyone, any role
--   * management: staff and customer users, but not owner or admin (and can't change an owner's or admin's account)
--   * customer admins: their own company's portal users only (customer admin or customer user)
--   * nobody changes their own role or switches themselves off, so a company can't lock itself out by accident
-- Changes go through these functions only (the direct table policies are removed), and each is in the audit log.

drop policy "User managers update profiles" on public.profiles;
drop policy "User managers manage invites" on public.user_invites;
create policy "User managers read invites" on public.user_invites for select to authenticated using ((select private.can_manage_users()));

-- Can the signed-in person give this role, for this company? Null when they can; otherwise the reason.
create or replace function private.user_change_blocker(p_role public.app_role, p_customer uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when private.my_role() in ('owner', 'admin') then null
    when private.my_role() = 'management' then
      case when p_role in ('owner', 'admin') then 'Only the owner or an admin can give the owner or admin role' end
    when private.my_role() = 'customer_admin' then
      case when p_role not in ('customer_admin', 'customer_user') or p_customer is distinct from private.my_customer_id()
           then 'You can only add people to your own company' end
    else 'You can''t manage users'
  end
$$;

create or replace function private.check_user_fields(p_role public.app_role, p_branch text, p_customer uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_role in ('customer_admin', 'customer_user') and p_customer is null then raise exception 'Choose the customer account for a portal user'; end if;
  if p_role not in ('customer_admin', 'customer_user') and p_customer is not null then raise exception 'Jet staff are not linked to a customer account'; end if;
  if p_role not in ('customer_admin', 'customer_user') and p_branch is null then raise exception 'Choose the branch for Jet staff'; end if;
end $$;

-- Invite someone (or change a pending invite). If they have already signed in, the invite applies straight away.
create or replace function public.invite_user(p_email text, p_full_name text, p_role public.app_role, p_branch text default null, p_customer uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_block text := private.user_change_blocker(p_role, p_customer);
  v_existing public.profiles;
begin
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email address doesn''t look right'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter their name'; end if;
  perform private.check_user_fields(p_role, p_branch, p_customer);
  select * into v_existing from public.profiles where email = v_email;
  if v_existing.id is not null then
    -- Already signed in: only someone who could manage that account as it is now may re-invite it.
    if v_existing.id = auth.uid() then raise exception 'You can''t change your own access'; end if;
    -- Someone who signed in before being invited has no company and no access yet, so anyone may invite them.
    if not (v_existing.role = 'customer_user' and v_existing.customer_id is null)
       and private.user_change_blocker(v_existing.role, v_existing.customer_id) is not null then
      raise exception 'That email already has an account; ask Jet Worldwide to change it' using errcode = '42501';
    end if;
  end if;
  delete from public.user_invites where email = v_email;
  insert into public.user_invites (email, full_name, role, branch_code, customer_id, invited_by)
  values (v_email, trim(p_full_name), p_role, case when p_role in ('customer_admin', 'customer_user') then null else p_branch end, p_customer, auth.uid());
  perform private.log_change('user_invites', v_email, jsonb_build_object('invited', v_email, 'role', p_role, 'branch', p_branch, 'customer', p_customer));
end $$;

create or replace function public.cancel_invite(p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare inv public.user_invites;
begin
  select * into inv from public.user_invites where email = lower(trim(p_email));
  if inv.email is null then raise exception 'No pending invite for %', p_email; end if;
  if private.user_change_blocker(inv.role, inv.customer_id) is not null then raise exception 'You can''t cancel that invite' using errcode = '42501'; end if;
  delete from public.user_invites where email = inv.email;
  perform private.log_change('user_invites', inv.email, jsonb_build_object('invite_cancelled', inv.email));
end $$;

-- Change someone's name, role, branch or access. Customer admins can't move people to another company.
create or replace function public.update_user(p_id uuid, p_full_name text, p_role public.app_role, p_branch text, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where id = p_id;
  if p.id is null then raise exception 'No such user'; end if;
  if p.id = auth.uid() and (p_role <> p.role or not p_active) then raise exception 'You can''t change your own role or switch yourself off'; end if;
  if private.user_change_blocker(p.role, p.customer_id) is not null then raise exception '%', private.user_change_blocker(p.role, p.customer_id) using errcode = '42501'; end if;
  if private.user_change_blocker(p_role, p.customer_id) is not null then raise exception '%', private.user_change_blocker(p_role, p.customer_id) using errcode = '42501'; end if;
  if (p.role in ('customer_admin', 'customer_user')) <> (p_role in ('customer_admin', 'customer_user')) then
    raise exception 'A portal user can''t become Jet staff (or the other way round); invite them again with the new role';
  end if;
  perform private.check_user_fields(p_role, p_branch, p.customer_id);
  update public.profiles
     set full_name = coalesce(nullif(trim(p_full_name), ''), full_name), role = p_role,
         branch_code = case when p_role in ('customer_admin', 'customer_user') then null else p_branch end, active = p_active
   where id = p_id;
end $$;

-- Everyone the signed-in person may manage, with pending invites and when each last signed in.
create or replace function public.user_directory()
returns table (id uuid, email text, full_name text, role public.app_role, branch_code text, customer_id uuid, account_code text, customer_name text,
               active boolean, pending boolean, last_sign_in_at timestamptz, created_at timestamptz, can_change boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.email, p.full_name, p.role, p.branch_code, p.customer_id, c.account_code, c.name, p.active, false, u.last_sign_in_at, p.created_at,
         p.id <> auth.uid() and private.user_change_blocker(p.role, p.customer_id) is null
    from public.profiles p left join auth.users u on u.id = p.id left join public.customers c on c.id = p.customer_id
   where private.can_manage_users() or (private.my_role() = 'customer_admin' and p.customer_id = private.my_customer_id())
  union all
  select null, i.email, i.full_name, i.role, i.branch_code, i.customer_id, c.account_code, c.name, true, true, null, i.created_at,
         private.user_change_blocker(i.role, i.customer_id) is null
    from public.user_invites i left join public.customers c on c.id = i.customer_id
   where private.can_manage_users() or (private.my_role() = 'customer_admin' and i.customer_id = private.my_customer_id())
$$;

revoke all on function private.user_change_blocker(public.app_role, uuid), private.check_user_fields(public.app_role, text, uuid) from public, anon;
grant execute on function private.user_change_blocker(public.app_role, uuid), private.check_user_fields(public.app_role, text, uuid) to authenticated;
revoke all on function public.invite_user(text, text, public.app_role, text, uuid), public.cancel_invite(text),
  public.update_user(uuid, text, public.app_role, text, boolean), public.user_directory() from public, anon;
grant execute on function public.invite_user(text, text, public.app_role, text, uuid), public.cancel_invite(text),
  public.update_user(uuid, text, public.app_role, text, boolean), public.user_directory() to authenticated;
