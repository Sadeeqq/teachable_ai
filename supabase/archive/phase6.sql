-- ═══════════════════════════════════════════════════════════════════════════
-- HISTORICAL MIGRATION — superseded by the consolidated schema.sql and the
-- usage_limits table/RPC in rate_limits.sql. Do not run on a current install:
-- this script creates the obsolete external_search_usage table.
-- Phase 6 — External Sources data model additions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Daily external-search rate limiting (PRD §8: protect free quotas) ─────
create table public.external_search_usage (
  user_id  uuid not null references public.users(id) on delete cascade,
  day      date not null default current_date,
  count    int not null default 0,
  primary key (user_id, day)
);

alter table public.external_search_usage enable row level security;
create policy "own external_search_usage" on public.external_search_usage
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Allow messages to record "general knowledge only" as a distinct
--    source_type from a real external web/youtube search ──────────────────
alter table public.messages drop constraint if exists messages_source_type_check;
alter table public.messages
  add constraint messages_source_type_check
  check (source_type in ('material','external_web','external_youtube','mixed','general_knowledge','none'));
