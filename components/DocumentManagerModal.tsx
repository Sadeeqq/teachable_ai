'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatTimestamp } from '@/lib/format-timestamp';

export interface ManagedDocument {
  id: string;
  filename: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error_message: string | null;
  uploaded_at: string;
}

interface ManagedSubject {
  id: string;
  name: string;
  documents?: ManagedDocument[];
}

export default function DocumentManagerModal({
  subject,
  onClose,
  onDocumentsChange,
  onToast,
}: {
  subject: ManagedSubject;
  onClose: () => void;
  onDocumentsChange: (subjectId: string, documents: ManagedDocument[]) => void;
  onToast: (message: string) => void;
}) {
  const supabase = createClient();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshDocuments(): Promise<ManagedDocument[] | null> {
    try {
      const { data, error } = await supabase
        .from('documents').select('id, filename, status, error_message, uploaded_at')
        .eq('subject_id', subject.id).order('uploaded_at', { ascending: true });
      if (error) throw error;
      const documents = data ?? [];
      onDocumentsChange(subject.id, documents);
      return documents;
    } catch {
      onToast("Couldn't refresh your files list — check your connection.");
      return null;
    }
  }

  async function handleFileUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const failures: string[] = [];
    const fileArray = Array.from(files);
    const optimisticEntries: ManagedDocument[] = fileArray.map((file, index) => ({
      id: `optimistic-${Date.now()}-${index}`,
      filename: file.name,
      status: 'pending',
      error_message: null,
      uploaded_at: new Date().toISOString(),
    }));
    onDocumentsChange(subject.id, [...(subject.documents ?? []), ...optimisticEntries]);
    const optimisticIds = new Set(optimisticEntries.map((document) => document.id));

    try {
      for (const file of fileArray) {
        let documentId: string | undefined;
        try {
          const initResponse = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'initialize', subject_id: subject.id, filename: file.name, size: file.size }),
          });
          const initData = await initResponse.json().catch(() => ({}));
          if (!initResponse.ok) throw new Error(initData.detail || `Upload preparation failed (${initResponse.status})`);
          documentId = initData.document_id;

          const { error: storageError } = await supabase.storage.from('documents').upload(initData.storage_path, file, {
            contentType: initData.content_type,
            upsert: false,
          });
          if (storageError) throw new Error(`Storage upload failed: ${storageError.message}`);

          const processResponse = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'process', document_id: documentId }),
          });
          const processData = await processResponse.json().catch(() => ({}));
          if (!processResponse.ok) throw new Error(processData.detail || `Indexing failed (${processResponse.status})`);
        } catch (error: any) {
          // Clean up the pending DB row and uploaded object when one stage of
          // the two-step upload pipeline fails.
          if (documentId) {
            await fetch(`/api/document/${documentId}`, { method: 'DELETE' }).catch(() => undefined);
          }
          failures.push(`${file.name}: ${error.message || 'network error'}`);
        }
      }
    } finally {
      // Never leave a temporary optimistic row showing "Processing" after
      // the request has finished, especially when the documents refresh fails.
      onDocumentsChange(subject.id, (subject.documents ?? []).filter((document) => !optimisticIds.has(document.id)));
      await refreshDocuments();
      setUploading(false);
    }
    if (failures.length) onToast(failures.join(' — '));
  }

  async function handleDeleteDocument(documentId: string) {
    if (!confirm('Delete this file?')) return;
    const previousDocuments = subject.documents ?? [];
    onDocumentsChange(subject.id, previousDocuments.filter((document) => document.id !== documentId));

    try {
      const response = await fetch(`/api/document/${documentId}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        onToast(`Couldn't delete file: ${data.detail || 'unknown error'}`);
        await refreshDocuments();
        return;
      }

      const result = await response.json().catch(() => ({}));
      if (result.warning) onToast(result.warning);
      const documents = await refreshDocuments();
      if (documents?.some((document) => document.id === documentId)) {
        onToast("The server still lists this file after deletion. Please try again.");
      }
    } catch {
      onToast("Couldn't delete file — check your connection and try again.");
      await refreshDocuments();
    }
  }

  const statusBadge = (status: ManagedDocument['status']) => {
    switch (status) {
      case 'ready': return <span className="file-pill indexed-badge">Indexed</span>;
      case 'failed': return <span className="file-pill indexing-badge" style={{ background: 'var(--error-bg)', color: 'var(--error-text)', border: '1px solid var(--error-border)' }}>Failed</span>;
      default: return <span className="file-pill indexing-badge">Processing…</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-3xl p-7 fade-in flex flex-col" style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-glass)', boxShadow: '0 24px 48px -8px rgba(0,0,0,0.30)', maxHeight: '85vh' }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Study Materials</h3>
            <p className="text-xs mt-0.5 font-bold" style={{ color: 'var(--text-muted)' }}>{subject.name}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center btn-ghost">
            <i className="fa-solid fa-xmark text-sm" />
          </button>
        </div>

        <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp" multiple className="hidden" onChange={(event) => handleFileUpload(event.target.files)} />
        <div id="dropZone" onClick={() => fileInputRef.current?.click()}
          className="flex flex-col items-center justify-center py-6 px-4 rounded-2xl mb-4 cursor-pointer text-center">
          {uploading ? (
            <>
              <div className="t-spinner w-6 h-6 mb-2" />
              <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Uploading &amp; indexing…</p>
              <p className="text-[0.65rem] mt-1" style={{ color: 'var(--text-muted)' }}>First upload can take 20–40s while the embedding model loads</p>
            </>
          ) : (
            <>
              <i className="fa-solid fa-cloud-arrow-up text-2xl mb-2" style={{ color: 'var(--peak-active-border)' }} />
              <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Click to upload study materials</p>
              <p className="text-[0.65rem] mt-1" style={{ color: 'var(--text-muted)' }}>PDF, DOCX, TXT, MD, CSV, JPG, PNG, or WebP · Max 20MB each</p>
            </>
          )}
        </div>

        <div className="custom-scrollbar overflow-y-auto space-y-2 flex-1">
          {!subject.documents?.length && (
            <div className="text-center py-8">
              <i className="fa-solid fa-file-pdf text-2xl mb-2" style={{ color: 'var(--text-muted)' }} />
              <p className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>No files uploaded yet</p>
            </div>
          )}
          {subject.documents?.map((document) => (
            <div key={document.id} className="file-pill justify-between group">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <i className={`fa-solid ${document.filename.toLowerCase().endsWith('.pdf') ? 'fa-file-pdf' : document.filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/) ? 'fa-file-image' : document.filename.toLowerCase().endsWith('.docx') ? 'fa-file-word' : 'fa-file-lines'} shrink-0`} style={{ color: 'var(--error-text)' }} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold" style={{ color: 'var(--text-primary)' }} title={document.filename}>{document.filename}</p>
                  <time dateTime={document.uploaded_at} title={new Date(document.uploaded_at).toLocaleString()}
                    className="block text-[0.58rem] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Uploaded {formatTimestamp(document.uploaded_at)}
                  </time>
                  {document.status === 'failed' && document.error_message && (
                    <p className="text-[0.6rem] mt-0.5" style={{ color: 'var(--error-text)' }}>{document.error_message}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {statusBadge(document.status)}
                <button onClick={() => handleDeleteDocument(document.id)}
                  className="w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                  style={{ color: 'var(--error-text)', background: 'var(--error-bg)' }}>
                  <i className="fa-solid fa-trash-can text-[0.55rem] pointer-events-none" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
