import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiAuthFailure, getApiUser } from '@/lib/supabase/api-auth';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { user, error: authError } = await getApiUser(supabase);
  if (!user) return apiAuthFailure(authError);

  const { data: doc, error: docError } = await supabase.from('documents')
    .select('storage_path')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single();
  if (docError || !doc) return NextResponse.json({ detail: 'Document not found.' }, { status: 404 });
  // Delete and confirm the database row first. Removing the storage object
  // before the row means a database failure leaves a visible, undeletable
  // document record pointing at a file that no longer exists.
  const { data: deletedDoc, error } = await supabase
    .from('documents').delete().eq('id', params.id).eq('user_id', user.id).select('id').maybeSingle();
  if (error) return NextResponse.json({ detail: error.message }, { status: 500 });
  if (!deletedDoc) {
    return NextResponse.json({ detail: 'Supabase did not confirm deleting this document. Refresh the list and try again.' }, { status: 409 });
  }

  // document_chunks cascade-delete and citations set null via FK. A storage
  // cleanup failure must not report the database deletion as unsuccessful,
  // since retrying would then fail with "Document not found".
  if (doc.storage_path) {
    const { error: storageError } = await supabase.storage.from('documents').remove([doc.storage_path]);
    if (storageError) {
      console.error(`[document-delete] Could not remove storage object for ${params.id}:`, storageError.message);
      return NextResponse.json({ success: true, warning: 'The document was deleted, but its stored file could not be removed.' });
    }
  }

  return NextResponse.json({ success: true });
}
