-- Apply to existing projects to make per-topic progress updates atomic.
-- Fresh projects get the same function from schema.sql.

create or replace function public.record_student_progress(
  p_user_id uuid,
  p_subject_id uuid,
  p_topic text,
  p_ratio double precision
)
returns void
language plpgsql
as $$
begin
  if p_user_id is distinct from auth.uid() then
    raise insufficient_privilege using message = 'Cannot update another user progress';
  end if;
  if p_ratio < 0 or p_ratio > 1 or p_ratio is null then
    raise invalid_parameter_value using message = 'Progress ratio must be between 0 and 1';
  end if;
  if p_topic is null or length(trim(p_topic)) = 0 then
    raise invalid_parameter_value using message = 'Progress topic cannot be empty';
  end if;

  insert into public.student_progress as current_progress (user_id, subject_id, topic, strength, attempts)
  values (p_user_id, p_subject_id, trim(p_topic), p_ratio, 1)
  on conflict (user_id, subject_id, topic) do update
    set strength = current_progress.strength * 0.7 + excluded.strength * 0.3,
        attempts = current_progress.attempts + 1,
        last_seen_at = now();
end;
$$;

grant execute on function public.record_student_progress(uuid, uuid, text, double precision) to authenticated;
