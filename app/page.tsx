import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Root entry point — mirrors the old index.html loader: check auth, redirect.
export default async function RootPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  redirect(user ? '/dashboard' : '/auth');
}
