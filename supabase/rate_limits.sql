-- Apply this migration to existing projects before deploying the rate-limit
-- RPC client. Fresh projects get the same table and function from schema.sql.

create table if not exists public.usage_limits (
  user_id  uuid not null references public.users(id) on delete cascade,
  day      date not null default current_date,
  kind     text not null check (kind in ('external_search','chat_message','upload')),
  count    int not null default 0 check (count >= 0),
  primary key (user_id, day, kind)
);

alter table public.usage_limits enable row level security;
drop policy if exists "own usage_limits" on public.usage_limits;
create policy "own usage_limits" on public.usage_limits
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop function if exists public.consume_usage_limit(uuid, date, text);

create function public.consume_usage_limit(
  p_user_id uuid,
  p_day date,
  p_kind text
)
returns table (allowed boolean)
language plpgsql
as $$
declare
  changed_rows int;
begin
  if p_user_id is distinct from auth.uid() then
    raise insufficient_privilege using message = 'Cannot consume another user quota';
  end if;
  if p_kind not in ('external_search', 'chat_message', 'upload') then
    raise invalid_parameter_value using message = 'Unknown usage limit kind';
  end if;

  insert into public.usage_limits as limits (user_id, day, kind, count)
  values (p_user_id, p_day, p_kind, 1)
  on conflict (user_id, day, kind) do update
    set count = limits.count + 1
    where limits.count < case p_kind
      when 'external_search' then 15
      when 'chat_message' then 300
      when 'upload' then 20
    end;
  get diagnostics changed_rows = row_count;
  allowed := changed_rows > 0;
  return next;
end;
$$;

grant execute on function public.consume_usage_limit(uuid, date, text) to authenticated;
