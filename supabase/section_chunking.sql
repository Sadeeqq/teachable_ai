-- Upgrade an existing Teachable database to persist inferred PDF sections.
-- Fresh installs get these changes from schema.sql.
alter table public.document_chunks add column if not exists section text;

-- PostgreSQL cannot change a table-returning function's return type with
-- CREATE OR REPLACE, so recreate the RPC to include its new section field.
drop function if exists public.match_document_chunks(vector, uuid, uuid, integer, double precision);

create function public.match_document_chunks(
  query_embedding vector(384),
  match_subject_id uuid,
  match_user_id uuid,
  match_count int default 5,
  match_threshold float default 0.3
)
returns table (
  id uuid,
  document_id uuid,
  filename text,
  page int,
  section text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    c.id, c.document_id, d.filename, c.page, c.section, c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.subject_id = match_subject_id
    and c.user_id = match_user_id
    and c.user_id = auth.uid()
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
