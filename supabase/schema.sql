-- ═══════════════════════════════════════════════════════════════════════════
-- Teachable AI 2.0 — Database Schema (consolidated)
-- Supabase Postgres + pgvector. Every table is owned by auth.uid() and
-- protected with Row Level Security so a user can never read/write another
-- user's data (PRD §5.1, §12).
--
-- This is the FULL schema for a fresh install — it supersedes the old
-- schema.sql + phase5.sql + phase6.sql three-file setup (those tables and
-- columns are folded in directly below rather than added via ALTER TABLE,
-- since there's no reason a new install should replay history that already
-- happened). If you already ran the three separate files on an existing
-- project, your database is already equivalent to this — do NOT re-run
-- this file there, it will just error on "already exists".
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ── users ─────────────────────────────────────────────────────────────────
create table public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email        text not null,
  created_at   timestamptz not null default now()
);

-- ── user_settings ─────────────────────────────────────────────────────────
create table public.user_settings (
  user_id            uuid primary key references public.users(id) on delete cascade,
  knowledge_mode     text not null default 'ask_before_external'
                       check (knowledge_mode in ('materials_only','ask_before_external','materials_web')),
  theme              text not null default 'light',
  updated_at         timestamptz not null default now()
);

-- ── subjects ──────────────────────────────────────────────────────────────
create table public.subjects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  name         text not null,
  knowledge_mode text check (knowledge_mode in ('materials_only','ask_before_external','materials_web')),
  created_at   timestamptz not null default now(),
  unique (user_id, name)
);

-- ── documents ─────────────────────────────────────────────────────────────
create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  subject_id     uuid not null references public.subjects(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  filename       text not null,
  storage_path   text not null,
  page_count     int,
  status         text not null default 'pending'
                   check (status in ('pending','processing','ready','failed')),
  error_message  text,
  uploaded_at    timestamptz not null default now()
);

-- ── document_chunks ───────────────────────────────────────────────────────
-- Section labels are inferred conservatively from PDF headings during upload.
create table public.document_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id) on delete cascade,
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  chunk_index  int not null,
  page         int,
  section      text,
  content      text not null,
  -- 384 dims: Xenova/all-MiniLM-L6-v2 run in-process via transformers.js
  -- (ONNX runtime, no PyTorch, no external embedding API — genuinely
  -- zero-cost per PRD §13, unlike a hosted inference API).
  embedding    vector(384),
  created_at   timestamptz not null default now()
);

create index document_chunks_embedding_idx
  on public.document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index document_chunks_subject_idx on public.document_chunks (subject_id);
create index document_chunks_generation_idx
  on public.document_chunks (subject_id, user_id, document_id, chunk_index);

-- ── chats ─────────────────────────────────────────────────────────────────
create table public.chats (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  title         text not null default 'New Chat',
  mode          text not null default 'tutor'
                  check (mode in ('tutor','summary','flashcards','practice','quiz','exam')),
  created_at    timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

-- ── messages ──────────────────────────────────────────────────────────────
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  source_type text check (source_type in ('material','external_web','external_youtube','mixed','general_knowledge','none')),
  created_at  timestamptz not null default now()
);

-- ── citations ─────────────────────────────────────────────────────────────
create table public.citations (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.messages(id) on delete cascade,
  kind         text not null check (kind in ('document','web','youtube')),
  document_id  uuid references public.documents(id) on delete set null,
  filename     text,
  page         int,
  section      text,
  url          text,
  title        text,
  channel      text,
  timestamp_s  int   -- reserved for YouTube timestamp citations — not yet
                      -- populated (Groq's search results don't return
                      -- per-timestamp data); harmless if left unused.
);

-- ── flashcard_sets ────────────────────────────────────────────────────────
create table public.flashcard_sets (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  title       text not null default 'Flashcards',
  cards       jsonb not null,  -- [{ id, front, back, citation: {filename, page} }]
  created_at  timestamptz not null default now()
);

-- ── assessments (quiz & exam question sets) ──────────────────────────────
create table public.assessments (
  id              uuid primary key default gen_random_uuid(),
  chat_id         uuid not null references public.chats(id) on delete cascade,
  subject_id      uuid not null references public.subjects(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  mode            text not null check (mode in ('quiz','exam')),
  title           text not null default 'Assessment',
  -- [{ id, type: 'multiple_choice'|'short_answer', prompt, options?,
  --    correct_answer, explanation, citation: {filename, page}, topic }]
  questions       jsonb not null,
  time_limit_seconds int,
  created_at      timestamptz not null default now()
);

-- ── study_sessions (quiz/exam/practice/flashcards results) ────────────────
create table public.study_sessions (
  id              uuid primary key default gen_random_uuid(),
  chat_id         uuid references public.chats(id) on delete set null,
  subject_id      uuid not null references public.subjects(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  mode            text not null check (mode in ('practice','quiz','exam','flashcards')),
  assessment_id   uuid references public.assessments(id) on delete set null,
  score           numeric,
  total           numeric,
  topic_breakdown jsonb,          -- { "topic": {correct, total} }
  answers         jsonb,          -- [{ question_id, given_answer, correct, feedback }]
  started_at      timestamptz not null default now(),
  completed_at    timestamptz
);

-- ── student_progress ─────────────────────────────────────────────────────
-- Rolling signal per subject/topic, updated (not overwritten) as evidence arrives.
create table public.student_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  topic        text not null,
  strength     numeric not null default 0.5,  -- 0..1 rolling signal
  attempts     int not null default 0,
  last_seen_at timestamptz not null default now(),
  unique (user_id, subject_id, topic)
);

-- ── usage_limits ──────────────────────────────────────────────────────────
-- Atomic daily quotas for chat messages, uploads, and external searches.
create table public.usage_limits (
  user_id  uuid not null references public.users(id) on delete cascade,
  day      date not null default current_date,
  kind     text not null check (kind in ('external_search','chat_message','upload')),
  count    int not null default 0 check (count >= 0),
  primary key (user_id, day, kind)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — every table: owner-only access
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.users                 enable row level security;
alter table public.user_settings         enable row level security;
alter table public.subjects              enable row level security;
alter table public.documents             enable row level security;
alter table public.document_chunks       enable row level security;
alter table public.chats                 enable row level security;
alter table public.messages              enable row level security;
alter table public.citations             enable row level security;
alter table public.flashcard_sets        enable row level security;
alter table public.assessments           enable row level security;
alter table public.study_sessions        enable row level security;
alter table public.student_progress      enable row level security;
alter table public.usage_limits           enable row level security;

create policy "own row" on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "own settings" on public.user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own subjects" on public.subjects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own documents" on public.documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own chunks" on public.document_chunks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own chats" on public.chats
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own messages" on public.messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own citations" on public.citations
  for all using (
    exists (select 1 from public.messages m
            where m.id = citations.message_id and m.user_id = auth.uid())
  );

create policy "own flashcard_sets" on public.flashcard_sets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own assessments" on public.assessments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own study_sessions" on public.study_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own progress" on public.student_progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Blend each new result atomically so concurrent submissions cannot lose
-- attempts or overwrite one another's strength update.
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

create policy "own usage_limits" on public.usage_limits
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Atomically consume one unit without allowing concurrent requests to exceed
-- the caller's daily limit. RLS remains enabled and the RPC checks the caller.
create or replace function public.consume_usage_limit(
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

-- ═══════════════════════════════════════════════════════════════════════════
-- pgvector similarity search RPC — subject-scoped
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.match_document_chunks(
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
    and c.user_id = auth.uid()  -- defense-in-depth: don't rely solely on the
                                 -- match_user_id parameter + inherited RLS —
                                 -- enforce the real caller identity directly,
                                 -- so this stays safe even if RLS or this
                                 -- function's security mode ever changes.
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Bounded, evenly spaced sampling for content generation. This avoids
-- transferring every chunk to the application just to retain a small sample.
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

-- ── Auto-create public.users row + default settings on signup ─────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data->>'display_name');
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
