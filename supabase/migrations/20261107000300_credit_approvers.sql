-- Who to tell that a credit note over the limit is waiting: active management and owners of its branch, never the
-- person who raised it; anyone in management elsewhere if that branch has nobody else (one manager raised it).
create or replace function public.credit_note_approvers(p_id uuid)
returns table (email text, full_name text)
language sql stable security definer set search_path = '' as $$
  with cn as (select branch_code, created_by from public.invoices where id = p_id and kind = 'credit' and private.is_staff()),
  managers as (
    select p.email, p.full_name, p.branch_code = cn.branch_code as same_branch
      from public.profiles p, cn
     where p.active and p.role in ('owner', 'management') and p.id is distinct from cn.created_by
  )
  select email, full_name from managers
   where same_branch or not exists (select 1 from managers where same_branch)
$$;
revoke all on function public.credit_note_approvers(uuid) from public, anon;
grant execute on function public.credit_note_approvers(uuid) to authenticated;
