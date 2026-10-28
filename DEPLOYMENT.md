# Hosting setup: GitHub, Supabase, and Vercel

The app is a Next.js server-rendered application. Vercel hosts the frontend and API routes; Supabase provides Postgres/pgvector, Auth, and private file storage. GitHub holds the source and triggers preview/production deployments.

## 1. Prepare the Supabase project

The current app already uses Supabase. Keep using the project that contains your subjects, documents, and uploaded files.

1. In the Supabase dashboard, confirm the project is healthy and note the **Project URL** and **publishable/anon key** from **Project Settings → API**. These are the only Supabase values the app needs in environment variables. Do not add a service-role key; the app does not use it.
2. Confirm the `documents` Storage bucket is **private** and has the ownership policies from `supabase/storage.sql`.
3. Set the global and `documents` bucket upload limit to at least **20 MB**, and restrict the bucket to the MIME types listed below. Do not run `schema.sql` on the existing project again. Only apply a migration if the database is missing it.
4. Under **Authentication → URL Configuration**, set **Site URL** to the final production URL (for example `https://your-domain.com`). Add the exact redirect `https://your-domain.com/auth/callback`, `http://localhost:3000/**`, and a Vercel preview pattern such as `https://*-<your-team-or-account>.vercel.app/**`.
5. If Google sign-in is enabled, confirm the Google OAuth app allows the Supabase Auth callback URL shown in **Authentication → Providers → Google**. The Google provider returns to Supabase; Supabase then redirects to `/auth/callback` on this app.

Allowed source types are PDF, DOCX, TXT, Markdown, CSV, JPG/JPEG, PNG, and WebP. Their MIME types are `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`, `text/csv`, `image/jpeg`, `image/png`, and `image/webp`.

## 2. Put the source on GitHub

1. Create a **private** GitHub repository.
2. In a terminal at the project root, initialize Git if this folder is not already connected to a repository, review the files, and make the first commit. Keep `.env.local`, `.env`, and all real keys out of Git; `.gitignore` already excludes them.
3. Add the GitHub repository as `origin` and push the `main` branch.
4. Check the repository's file list on GitHub to confirm no environment files or secrets were committed.

This workspace does not currently contain a usable Git repository (`.git` is empty), so the Git initialization and push need to happen in the normal project terminal once you are ready to create the remote.

## 3. Import to Vercel

1. In Vercel, choose **Add New → Project**, connect GitHub, and import the repository.
2. Keep the detected framework as **Next.js**. Use the repository root as the Root Directory, `npm run build` as the build command, and leave the output directory on its default.
3. Use Node.js **22** (the repository's `.nvmrc` and `engines` specify Node 22+).
4. Add these variables in Vercel's **Environment Variables**. Set them for Production and Preview as appropriate; use separate Supabase projects for Preview/Production if you want test data isolated.

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key |
   | `NEXT_PUBLIC_SITE_URL` | Production site's full HTTPS origin, e.g. `https://your-domain.com` |
   | `GROQ_API_KEY` | Server-side Groq API key |
   | `OPENAI_API_KEY` | Optional fallback key; leave unset if unused |
   | `OPENAI_FALLBACK_MODEL` | Optional; defaults to `gpt-4o-mini` |

5. Deploy. Vercel will deploy future pushes to the production branch and create preview deployments for other branches/PRs.
6. Add the custom domain in Vercel, then update `NEXT_PUBLIC_SITE_URL` to that domain, ensure the Supabase redirect URLs include it, and redeploy.

## 4. First deployment checks

- Open the production URL and confirm sign-in/sign-out, subject creation, chat, flashcards, quiz/exam, progress, and delete.
- Upload one small sample of each supported format. Uploads now go directly from the browser to the private Supabase Storage bucket, then the Vercel API extracts and indexes the file. This avoids Vercel's 4.5 MB function request-body limit while retaining the app's 20 MB application limit.
- The Vercel upload API allows up to 300 seconds for OCR, model initialization, and indexing. Watch the first invocation in Vercel Functions logs: the local embedding model is downloaded on first cold start, and image OCR also retrieves English language data. If builds fail on function package size or uploads time out, move embedding/OCR to a dedicated worker or external service rather than raising the browser request size.
- Verify Supabase Auth email links and Google OAuth redirects use the production domain.
- Review Vercel build and runtime logs, then confirm the deployed version is the intended Git commit.

## Local production build

```sh
npm ci
npm run build
```

Set the same required environment variables in `.env.local` for local testing. Never put secrets in `NEXT_PUBLIC_*` variables.
