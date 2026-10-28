-- ═══════════════════════════════════════════════════════════════════════════
-- HISTORICAL MIGRATION — superseded by the consolidated schema.sql.
-- Do not run on a current installation. Kept for reference when upgrading
-- databases that predate the consolidated fresh-install schema.
-- Phase 5 — Study Modes data model additions.
--
-- Quiz/Exam/Flashcards need real structured data (questions, correct
-- answers, scores) to actually function as assessments — not just chat
-- text — so this adds two new tables and extends study_sessions to link
-- back to the specific assessment that was taken.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── flashcard_sets ─────────────────────────────────────────────────────────
create table public.flashcard_sets (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  title       text not null default 'Flashcards',
  cards       jsonb not null,  -- [{ id, front, back, citation: {filename, page} }]
  created_at  timestamptz not null default now()
);

alter table public.flashcard_sets enable row level security;
create policy "own flashcard_sets" on public.flashcard_sets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

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

alter table public.assessments enable row level security;
create policy "own assessments" on public.assessments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Extend study_sessions to link back to the assessment taken, and store
--    the student's actual answers alongside the score ──────────────────────
alter table public.study_sessions
  add column if not exists assessment_id uuid references public.assessments(id) on delete set null,
  add column if not exists answers jsonb;   -- [{ question_id, given_answer, correct, feedback }]

-- 'flashcards' sessions (a review pass) are also worth tracking for progress
alter table public.study_sessions drop constraint if exists study_sessions_mode_check;
alter table public.study_sessions
  add constraint study_sessions_mode_check check (mode in ('practice','quiz','exam','flashcards'));
