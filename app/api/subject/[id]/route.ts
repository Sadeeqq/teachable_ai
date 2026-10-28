import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const { data: subject, error: subjectError } = await supabase.from('subjects').select('id').eq('id', params.id).single();
  if (subjectError || !subject) return NextResponse.json({ detail: 'Subject not found.' }, { status: 404 });

  const { data: docs, error: docsError } = await supabase.from('documents').select('storage_path').eq('subject_id', params.id);
  if (docsError) return NextResponse.json({ detail: 'Could not list the subject files. Nothing was deleted; please retry.' }, { status: 500 });
  const paths = (docs ?? []).map((d) => d.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('documents').remove(paths);
    if (storageError) {
      console.error(`[subject-delete] Could not remove storage objects for ${params.id}:`, storageError.message);
      return NextResponse.json({ detail: 'Could not remove all stored files. The subject was not deleted; please retry.' }, { status: 502 });
    }
  }

  const { data: deletedSubject, error } = await supabase
    .from('subjects').delete().eq('id', params.id).select('id').maybeSingle();
  if (error) return NextResponse.json({ detail: error.message }, { status: 500 });
  if (!deletedSubject) {
    return NextResponse.json({ detail: 'Supabase did not confirm deleting this subject. Refresh the list and try again.' }, { status: 409 });
  }

  revalidatePath('/dashboard');
  return NextResponse.json({ success: true });
}
