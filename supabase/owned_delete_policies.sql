-- Existing projects may have owner SELECT/INSERT/UPDATE policies without a
-- matching DELETE policy. PostgREST can treat a DELETE filtered to zero rows
-- as successful, so install explicit owner-scoped delete policies.

alter table public.documents enable row level security;
alter table public.subjects enable row level security;

drop policy if exists "owned document delete" on public.documents;
create policy "owned document delete" on public.documents
  for delete using (user_id = auth.uid());

drop policy if exists "owned subject delete" on public.subjects;
create policy "owned subject delete" on public.subjects
  for delete using (user_id = auth.uid());
