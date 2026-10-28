'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function signIn(formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const supabase = createClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: friendlyError(error.message) };

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}

export async function signUp(formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const confirm = formData.get('confirm') as string;

  if (!name?.trim()) return { error: 'Please enter your name.' };
  const hasMinLength = password.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (!hasMinLength) return { error: 'Password must be at least 8 characters.' };
  if (!hasLetter || !hasNumber) return { error: 'Password must contain both letters and numbers.' };
  if (password !== confirm) return { error: 'Passwords do not match.' };

  const supabase = createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: name } },
  });
  if (error) return { error: friendlyError(error.message) };

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}

export async function signInWithGoogle() {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback` },
  });
  if (error) return { error: friendlyError(error.message) };
  if (data.url) redirect(data.url);
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/auth');
}

function friendlyError(message: string): string {
  const map: Record<string, string> = {
    'Invalid login credentials': 'Incorrect email or password.',
    'User already registered': 'An account with this email already exists.',
    'Password should be at least 6 characters.': 'Password must be at least 8 characters with letters and numbers.',
  };
  return map[message] || message;
}
