# Teachable AI — Code Quality Review

Reviewed the active application under `app/`, `components/`, `lib/`, and
`supabase/` on 2026-10-21. This is a static maintainability review; no tests or
build were run.

## Cleanup completed

- Removed the unreferenced `eng.traineddata` asset and an abandoned partial
  download from the Supabase folder.
- Moved obsolete phase SQL scripts to `supabase/archive/` and documented the
  current bounded-sampling migration.
- Bounded generation chunk sampling in Postgres rather than fetching every
  chunk into the application.
- Fixed progress query error handling, consolidated assessment result
  enrichment, ran topic progress RPCs concurrently, and reused the common
  owned subject/chat lookup in generation routes.
- Updated PDF-only upload copy to refer to supported study materials.
- Narrowed the dashboard profile and progress queries to the fields the UI uses.
- Removed the unused root OCR language-data file and the abandoned partial
  download that had been placed in `supabase/`.

- Extracted chat answer and external-source branching to
  `lib/rag/chatFlow.ts`, leaving the API route to coordinate request setup,
  retrieval, persistence, and progress updates.
- Extracted document upload/list/delete UI into
  `components/DocumentManagerModal.tsx` to reduce the size of
  `components/DashboardShell.tsx`.
- Consolidated external citation construction in the chat flow and removed
  unused rate-limit result fields from the client/RPC response.
- Removed the unused Supabase admin client and removed
  `external_search_usage` from the fresh-install schema. Current quotas use
  `usage_limits`; the old table definition remains only in
  `archive/phase6.sql`.
- Removed confirmed dead CSS selectors and associated animation styles.
- Updated setup guidance to distinguish fresh installs from existing database
  upgrades. The shared `GenerationScreen`, `loadMessages()` helper, inferred
  document sections, and mobile sidebar controls are already implemented.

## Remaining maintenance notes

### Historical SQL scripts

`archive/phase5.sql` and `archive/phase6.sql` describe the pre-consolidation schema history.
They are not part of fresh setup; `schema.sql` includes the current tables and
columns. In particular, the old `external_search_usage` table in `archive/phase6.sql`
has been replaced by `usage_limits` and must not be created for a current
installation.

The obsolete `harden_rpc.sql` script was removed. It recreated the
vector-search RPC without its current `section` return column; use
`section_chunking.sql` only when upgrading a database that lacks that change.

Generation sampling is bounded in the database through
`sample_document_chunks.sql`; fresh installs receive the function from
`schema.sql`.

### RPC quota migration compatibility

The current app reads only the `allowed` field from `consume_usage_limit`, so
the previously deployed RPC response that also returned `current_count` remains
backward compatible. Updated fresh schemas and `rate_limits.sql` now return
only `allowed`.

## Follow-up opportunities

- Organize database changes as ordered, versioned migrations so the historical
  scripts cannot be mistaken for current setup instructions.
- Split the remaining dashboard orchestration component by responsibility.
- Add ESLint and its Next.js config as dev dependencies; the package install
  could not complete in the restricted environment, so no lint config was added.
- Consider splitting persistence/progress writes from the chat route if the
  chat workflow grows further; current answer branching is already extracted.
- Keep the repository README and this audit aligned when schema or feature
  work changes the setup path.
