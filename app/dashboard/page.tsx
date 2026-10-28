import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import DashboardShell from '@/components/DashboardShell';

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth');

  const { data: profile } = await supabase.from('users').select('display_name').eq('id', user.id).single();
  // Fetch full document rows (not just a count) so the UI can show real
  // per-file status (pending/processing/ready/failed) instead of a count
  // that includes failed uploads as if they succeeded.
  const { data: subjects, error: subjectsError } = await supabase
    .from('subjects')
    .select('*, documents(id, filename, status, error_message, uploaded_at), chats(*)')
    .order('created_at', { ascending: true });

  // A genuine DB/network failure here would otherwise look IDENTICAL to
  // "you have no subjects yet" — subjects defaults to null either way, and
  // the empty-state UI has no way to tell the difference. That's actively
  // misleading (a real outage looks like an invitation to create a
  // subject), so surface it as a real error screen instead.
  if (subjectsError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg-page)' }}>
        <div className="text-center max-w-sm">
          <i className="fa-solid fa-triangle-exclamation text-3xl mb-4" style={{ color: 'var(--error-text)' }} />
          <h2 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Couldn&apos;t load your subjects</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Something went wrong loading your data. Try refreshing the page — if this keeps happening, check your connection.
          </p>
          <a href="/dashboard" className="inline-block px-5 py-2.5 rounded-full text-sm font-bold btn-primary transition">Retry</a>
        </div>
      </div>
    );
  }

  return (
    <DashboardShell
      user={{ id: user.id, email: user.email!, displayName: profile?.display_name || null }}
      initialSubjects={subjects ?? []}
    />
  );
}
