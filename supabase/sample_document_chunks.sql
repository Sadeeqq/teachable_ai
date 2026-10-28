-- Apply to existing projects to sample a bounded set of chunks for generation.
-- Fresh projects get the same function from schema.sql.

create index if not exists document_chunks_generation_idx
  on public.document_chunks (subject_id, user_id, document_id, chunk_index);

create or replace function public.sample_document_chunks(
  p_subject_id uuid,
  p_user_id uuid,
  p_max_chunks integer default 20
)
returns table (
  id uuid,
  document_id uuid,
  filename text,
  page integer,
  section text,
  content text,
  chunk_index integer
)
language plpgsql
set search_path = public
as $$
begin
  if p_user_id is distinct from auth.uid() then
    raise insufficient_privilege using message = 'Cannot sample another user materials';
  end if;
  if p_max_chunks is null or p_max_chunks < 1 or p_max_chunks > 100 then
    raise invalid_parameter_value using message = 'Chunk sample size must be between 1 and 100';
  end if;

  return query
  with source_chunks as (
    select c.id, c.document_id, d.filename, c.page, c.section, c.content, c.chunk_index
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    where c.subject_id = p_subject_id
      and c.user_id = p_user_id
      and c.user_id = auth.uid()
      and d.status = 'ready'
  ),
  numbered_chunks as (
    select source_chunks.*,
      row_number() over (partition by source_chunks.document_id order by source_chunks.chunk_index) as row_num,
      count(*) over (partition by source_chunks.document_id) as document_chunk_count
    from source_chunks
  ),
  document_counts as (
    select numbered_chunks.document_id,
      max(numbered_chunks.document_chunk_count)::integer as chunk_count
    from numbered_chunks
    group by numbered_chunks.document_id
  ),
  sampling_budget as (
    select document_counts.document_id,
      document_counts.chunk_count,
      greatest(1, floor(p_max_chunks::numeric / (select count(*) from document_counts))::integer) as per_document,
      floor(random() * document_counts.chunk_count)::integer as random_offset,
      random() as document_order
    from document_counts
  ),
  sample_targets as (
    select b.document_id,
      1 + mod(
        b.random_offset + floor(i.sample_index * b.chunk_count::numeric / least(b.per_document, b.chunk_count))::integer,
        b.chunk_count
      ) as row_num,
      b.document_order
    from sampling_budget b
    cross join lateral generate_series(0, least(b.per_document, b.chunk_count) - 1) as i(sample_index)
  )
  select n.id, n.document_id, n.filename, n.page, n.section, n.content, n.chunk_index
  from sample_targets t
  join numbered_chunks n on n.document_id = t.document_id and n.row_num = t.row_num
  order by t.document_order, n.chunk_index
  limit p_max_chunks;
end;
$$;

grant execute on function public.sample_document_chunks(uuid, uuid, integer) to authenticated;
