'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { createClient } from '@/lib/supabase/client';
import { signOut } from '@/app/auth/actions';
import { createSubject, renameSubject, createChat } from '@/app/dashboard/actions';
import ThemeSelect from './ThemeSelect';
import FlashcardDeck from './FlashcardDeck';
import AssessmentRunner from './AssessmentRunner';
import ProgressPanel from './ProgressPanel';
import SubjectSettingsPanel from './SubjectSettingsPanel';
import SanitizedMarkdown from './SanitizedMarkdown';
import DocumentManagerModal, { type ManagedDocument } from './DocumentManagerModal';
import { formatDocumentCitation } from '@/lib/rag/citations';
import { formatTimestamp } from '@/lib/format-timestamp';

type Mode = 'tutor' | 'summary' | 'flashcards' | 'practice' | 'quiz' | 'exam';
const MODES: { id: Mode; label: string }[] = [
  { id: 'tutor', label: 'Tutor' },
  { id: 'summary', label: 'Summary' },
  { id: 'flashcards', label: 'Flashcards' },
  { id: 'practice', label: 'Practice' },
  { id: 'quiz', label: 'Quiz' },
  { id: 'exam', label: 'Exam' },
];

interface Subject { id: string; name: string; knowledge_mode?: string | null; documents?: ManagedDocument[]; chats?: Chat[]; }
interface Chat { id: string; title: string; mode: Mode; subject_id: string; }
interface Message { id?: string; role: 'user' | 'assistant'; content: string; created_at?: string; sources?: SourceRef[]; }
interface SourceRef { kind?: 'document' | 'web' | 'youtube'; filename?: string; page?: number | null; section?: string | null; title?: string; url?: string; channel?: string; timestamp_s?: number | null; }

export default function DashboardShell({
  user, initialSubjects,
}: { user: { id: string; email: string; displayName: string | null }; initialSubjects: Subject[] }) {
  const supabase = createClient();
  const [subjects, setSubjects] = useState<Subject[]>(initialSubjects);
  const [search, setSearch] = useState('');
  const [activeSubject, setActiveSubject] = useState<Subject | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);
  const [newSubjectName, setNewSubjectName] = useState('');
  const [modalError, setModalError] = useState('');
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  const readyDocs = (s: Subject) => (s.documents ?? []).filter((d) => d.status === 'ready');
  const hasDocs = activeSubject ? readyDocs(activeSubject).length > 0 : false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadMessages(chatId: string) {
    try {
      const { data, error } = await supabase.from('messages').select('*').eq('chat_id', chatId).order('created_at');
      if (error) throw error;

      const loadedMessages = (data ?? []) as Message[];
      const messageIds = loadedMessages.map((message) => message.id).filter((id): id is string => !!id);
      if (!messageIds.length) {
        setMessages(loadedMessages);
        return;
      }

      const { data: citations, error: citationsError } = await supabase
        .from('citations')
        .select('message_id, kind, filename, page, section, title, url, channel, timestamp_s')
        .in('message_id', messageIds);
      if (citationsError) {
        setMessages(loadedMessages);
        setToast("Chat history loaded, but its citations couldn't be restored.");
        return;
      }

      const sourcesByMessage = new Map<string, SourceRef[]>();
      for (const citation of citations ?? []) {
        const sources = sourcesByMessage.get(citation.message_id) ?? [];
        sources.push(citation as SourceRef);
        sourcesByMessage.set(citation.message_id, sources);
      }
      setMessages(loadedMessages.map((message) => ({
        ...message,
        sources: message.id ? sourcesByMessage.get(message.id) ?? [] : [],
      })));
    } catch {
      setMessages([]);
      setToast("Couldn't load this chat's history — check your connection.");
    }
  }

  async function selectSubject(subj: Subject) {
    // Optimistic subjects do not have a database id/chat until creation ends.
    if (subj.id.startsWith('temp-')) return;
    setActiveSubject(subj);
    setSidebarOpen(false); // close the mobile drawer once a subject is picked
    const chats = subj.chats ?? [];
    let chat = chats.find((c) => c.mode === 'tutor') ?? chats[0] ?? null;
    if (!chat) {
      const result = await createChat(subj.id, 'tutor', 'General Chat');
      if (!result.chat) {
        setActiveChat(null);
        setMessages([]);
        setToast(`Couldn't open this subject: ${result.error ?? 'Tutor chat could not be initialized.'}`);
        return;
      }
      chat = result.chat;
      const updated = { ...subj, chats: [chat] };
      setActiveSubject(updated);
      setSubjects((prev) => prev.map((item) => item.id === subj.id ? updated : item));
    }
    setActiveChat(chat);
    await loadMessages(chat.id);
  }

  async function switchMode(mode: Mode) {
    if (!activeSubject) return;
    const existing = activeSubject.chats?.find((c) => c.mode === mode);
    if (existing) {
      setActiveChat(existing);
      await loadMessages(existing.id);
      return;
    }
    const res = await createChat(activeSubject.id, mode, MODES.find((m) => m.id === mode)!.label);
    if (res.chat) {
      const updated = { ...activeSubject, chats: [...(activeSubject.chats ?? []), res.chat] };
      setActiveSubject(updated);
      setSubjects((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setActiveChat(res.chat);
      setMessages([]);
    } else {
      setToast(`Couldn't open ${mode}: ${res.error ?? 'chat could not be created.'}`);
    }
  }

  // Bring a specific quiz/exam question into the Tutor chat for a deeper
  // explanation — switches to (or creates) the Tutor chat and pre-fills the
  // input so the student can review/edit before sending, rather than
  // silently auto-sending on their behalf.
  async function askTutorAbout(prompt: string) {
    await switchMode('tutor');
    setInput(prompt);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !activeSubject || !activeChat || sending) return;

    setMessages((prev) => [...prev, { role: 'user', content: text, created_at: new Date().toISOString() }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: activeChat.id,
          subject_id: activeSubject.id,
          question: text,
          history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (res.redirected && new URL(res.url).pathname.startsWith('/auth')) {
        throw new Error('Your session has expired. Please sign in again.');
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error(`The server returned an unexpected response (HTTP ${res.status}). Please refresh and try again.`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'The AI tutor encountered an error.');
      if (data.progress_warning) setToast('Your practice answer was saved, but learning progress could not be updated.');
      setMessages((prev) => [...prev, { role: 'assistant', content: data.answer, created_at: data.created_at ?? new Date().toISOString(), sources: data.sources }]);
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `I'm having trouble right now. _Error: ${err.message}_`, created_at: new Date().toISOString() }]);
    } finally {
      setSending(false);
    }
  }

  // ── Create subject: optimistic insert with a temp id, modal closes
  // immediately. On failure the temp entry is removed and a toast explains
  // why — e.g. a duplicate name only the server can actually detect.
  function handleCreateSubject() {
    const name = newSubjectName.trim();
    if (!name) { setModalError('Please enter a subject name.'); return; }
    setModalError('');

    if (editingSubjectId) {
      const subjectId = editingSubjectId;
      const previousName = subjects.find((s) => s.id === subjectId)?.name;
      setSubjects((prev) => prev.map((s) => s.id === subjectId ? { ...s, name } : s));
      setActiveSubject((prev) => prev?.id === subjectId ? { ...prev, name } : prev);
      setModalOpen(false);
      setEditingSubjectId(null);
      setNewSubjectName('');

      startTransition(async () => {
        let error = '';
        try {
          const res = await renameSubject(subjectId, name);
          error = 'error' in res ? res.error ?? 'unknown error' : ('subject' in res && res.subject ? '' : 'unknown error');
        } catch (err: any) {
          error = err.message || 'network error';
        }
        if (error) {
          if (previousName) {
            setSubjects((prev) => prev.map((s) => s.id === subjectId ? { ...s, name: previousName } : s));
            setActiveSubject((prev) => prev?.id === subjectId ? { ...prev, name: previousName } : prev);
          }
          setToast(`Couldn't rename subject: ${error}`);
        }
      });
      return;
    }

    const tempId = `temp-${Date.now()}`;
    setSubjects((prev) => [...prev, { id: tempId, name, documents: [], chats: [] }]);
    setModalOpen(false);
    setNewSubjectName('');

    startTransition(async () => {
      const res = await createSubject(name);
      if (res.error) {
        setSubjects((prev) => prev.filter((s) => s.id !== tempId));
        setToast(`Couldn't create subject: ${res.error}`);
        return;
      }
      if (res.subject && res.chat) {
        const created = { ...res.subject, documents: [], chats: [res.chat] };
        setSubjects((prev) => prev.map((s) => (s.id === tempId ? created : s)));
      }
    });
  }

  // ── Delete subject: optimistic removal, restored at its original
  // position + a toast if the delete actually fails server-side.
  async function handleDeleteSubject(id: string) {
    if (!confirm('Delete this subject and all its documents?')) return;

    const removed = subjects.find((s) => s.id === id);
    const removedIndex = subjects.findIndex((s) => s.id === id);
    const wasActive = activeSubject?.id === id;
    const previousActiveChat = activeChat;
    const previousMessages = messages;

    setSubjects((prev) => prev.filter((s) => s.id !== id));
    if (wasActive) { setActiveSubject(null); setActiveChat(null); setMessages([]); }

    try {
      const response = await fetch(`/api/subject/${id}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'unknown error');
    } catch (err: any) {
      if (removed) {
        setSubjects((prev) => {
          const next = [...prev];
          next.splice(Math.min(removedIndex, next.length), 0, removed);
          return next;
        });
      }
      if (wasActive && removed) {
        setActiveSubject(removed);
        setActiveChat(previousActiveChat);
        setMessages(previousMessages);
      }
      setToast(`Couldn't delete subject: ${err.message || 'check your connection and try again'}`);
    }
  }

  const filtered = subjects.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div id="appShell">
      {/* NAVBAR */}
      <header className="flex items-center justify-between px-5 py-3.5 border-b shrink-0"
        style={{ background: 'var(--bg-header)', borderColor: 'var(--border-glass)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center gap-2.5">
          <button id="menuBtn" onClick={() => setSidebarOpen(true)}
            className="hidden w-9 h-9 rounded-xl items-center justify-center btn-ghost" aria-label="Open subjects menu">
            <i className="fa-solid fa-bars text-sm" />
          </button>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg" style={{ background: 'var(--btn-primary-bg)' }}>
            <i className="fa-solid fa-brain text-white text-sm" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight leading-none" style={{ color: 'var(--text-primary)' }}>Teachable</h1>
            <p className="text-[0.55rem] font-bold uppercase tracking-widest leading-none mt-0.5" style={{ color: 'var(--text-secondary)' }}>AI Study Tutor</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <ThemeSelect />
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-glass)' }}>
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[0.6rem] font-black text-white" style={{ background: 'var(--peak-active-border)' }}>
              {(user.displayName || user.email)[0]?.toUpperCase()}
            </div>
            <span className="text-xs font-bold hidden sm:block" style={{ color: 'var(--text-primary)' }}>{user.displayName || user.email.split('@')[0]}</span>
          </div>
          <form action={signOut}>
            <button className="w-9 h-9 rounded-full flex items-center justify-center border transition hover:scale-105"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border-glass)', color: 'var(--text-muted)' }} title="Sign out">
              <i className="fa-solid fa-right-from-bracket text-sm" />
            </button>
          </form>
        </div>
      </header>

      <div id="mainRow">
        {/* Mobile overlay — closes the sidebar drawer when tapped outside it */}
        <div id="sidebarOverlay" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

        {/* SIDEBAR */}
        <aside id="subjectSidebar" className={`custom-scrollbar ${sidebarOpen ? 'open' : ''}`}>
          <div className="px-4 py-4 border-b shrink-0" style={{ borderColor: 'var(--border-glass)' }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[0.65rem] font-black uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>My Subjects</p>
              <button onClick={() => { setEditingSubjectId(null); setNewSubjectName(''); setModalError(''); setModalOpen(true); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.68rem] font-bold transition btn-primary">
                <i className="fa-solid fa-plus text-[0.6rem]" /> New Subject
              </button>
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="Search subjects…"
              className="t-input w-full px-3 py-2 rounded-xl text-xs" style={{ outline: 'none' }} />
          </div>
          <div id="subjectList" className="custom-scrollbar p-3 space-y-1.5 overflow-y-auto flex-1">
            {!filtered.length && (
              <div className="text-center py-8">
                <i className="fa-solid fa-book-open text-2xl mb-3" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>No subjects yet</p>
                <p className="text-[0.65rem] mt-1" style={{ color: 'var(--text-muted)' }}>Click &quot;New Subject&quot; to get started</p>
              </div>
            )}
            {filtered.map((subj) => (
              <div key={subj.id} onClick={() => selectSubject(subj)}
                className={`subject-item px-3 py-2.5 flex items-center justify-between group ${activeSubject?.id === subj.id ? 'active' : ''}`}>
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-black shrink-0" style={{ background: 'var(--btn-primary-bg)' }}>
                    {subj.name[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="subject-name text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{subj.name}</p>
                    <p className="text-[0.6rem] font-bold" style={{ color: 'var(--text-muted)' }}>
                      {readyDocs(subj).length} ready{(subj.documents?.length ?? 0) > readyDocs(subj).length ? ` · ${(subj.documents?.length ?? 0) - readyDocs(subj).length} pending/failed` : ''}
                    </p>
                  </div>
                </div>
                <button onClick={(e) => {
                  e.stopPropagation();
                  setEditingSubjectId(subj.id);
                  setNewSubjectName(subj.name);
                  setModalError('');
                  setModalOpen(true);
                }}
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center transition shrink-0 btn-ghost"
                  title="Rename subject">
                  <i className="fa-solid fa-pen text-[0.6rem] pointer-events-none" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteSubject(subj.id); }}
                  className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center transition shrink-0"
                  style={{ color: 'var(--error-text)', background: 'var(--error-bg)' }}>
                  <i className="fa-solid fa-trash-can text-[0.6rem] pointer-events-none" />
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* CHAT COLUMN */}
        <div id="chatColumn">
          {activeSubject ? (
            <>
              <div className="px-5 py-3.5 border-b flex items-center justify-between shrink-0 flex-wrap gap-2"
                style={{ background: 'var(--bg-header)', borderColor: 'var(--border-glass)', backdropFilter: 'blur(20px)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-sm" style={{ background: 'var(--btn-primary-bg)' }}>
                    {activeSubject.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{activeSubject.name}</p>
                    <p className="text-[0.6rem] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{readyDocs(activeSubject).length} document{readyDocs(activeSubject).length !== 1 ? 's' : ''} ready</p>
                  </div>
                </div>
                <div id="subjectHeaderActions" className="flex items-center gap-1.5 flex-wrap">
                  {MODES.map((m) => (
                    <button key={m.id} onClick={() => switchMode(m.id)} className={`mode-pill ${activeChat?.mode === m.id ? 'active' : ''}`}>
                      {m.label}
                    </button>
                  ))}
                  <button onClick={() => setProgressOpen(true)} className="header-action-btn flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.7rem] font-bold btn-ghost transition">
                    <i className="fa-solid fa-chart-line text-[0.65rem]" /> Progress
                  </button>
                  <button onClick={() => setSettingsOpen(true)} className="header-action-btn flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.7rem] font-bold btn-ghost transition" title="Subject settings">
                    <i className="fa-solid fa-gear text-[0.65rem]" />
                  </button>
                  <button onClick={() => setFileManagerOpen(true)} className="header-action-btn flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.7rem] font-bold btn-ghost transition">
                    <i className="fa-solid fa-paperclip text-[0.65rem]" /> Files
                    {!!activeSubject.documents?.length && <span className="opacity-60">({activeSubject.documents.length})</span>}
                  </button>
                </div>
              </div>

              {activeChat?.mode === 'flashcards' ? (
                <FlashcardDeck chatId={activeChat.id} subjectId={activeSubject.id} />
              ) : activeChat?.mode === 'quiz' || activeChat?.mode === 'exam' ? (
                <AssessmentRunner chatId={activeChat.id} subjectId={activeSubject.id} mode={activeChat.mode} onAskTutor={askTutorAbout} />
              ) : (
              <>
              <div id="chatMessages" ref={scrollRef} className="custom-scrollbar">
                {!messages.length && (
                  <div className="msg-row fade-in">
                    <div className="avatar avatar-ai"><i className="fa-solid fa-brain text-white text-[0.55rem]" /></div>
                    <div className="bubble bubble-ai rounded-2xl">
                      {hasDocs
                        ? `I'm ready to help you study **${activeSubject.name}**. Ask me anything.`
                        : `Welcome to **${activeSubject.name}**! Upload study materials using the **Files** button, then ask me anything.`}
                    </div>
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg-row fade-in ${m.role === 'user' ? 'user' : ''}`}>
                    <div className={`avatar ${m.role === 'user' ? 'avatar-user' : 'avatar-ai'}`}>
                      {m.role === 'user' ? (user.displayName || user.email)[0]?.toUpperCase() : <i className="fa-solid fa-brain text-white text-[0.55rem]" />}
                    </div>
                    <div className={`bubble rounded-2xl ${m.role === 'user' ? 'bubble-user' : 'bubble-ai'}`}>
                      {m.role === 'assistant'
                        ? <SanitizedMarkdown content={m.content} />
                        : m.content}
                      {!!m.sources?.length && (
                        <div className="flex flex-wrap gap-1.5 mt-3">
                          {m.sources.map((s, j) => {
                            if (s.kind === 'web') {
                              return (
                                <a key={j} href={s.url} target="_blank" rel="noopener noreferrer" className="source-card" style={{ textDecoration: 'none' }}>
                                  <i className="fa-solid fa-globe mr-1" />{s.title}
                                </a>
                              );
                            }
                            if (s.kind === 'youtube') {
                              const time = s.timestamp_s != null
                                ? `${Math.floor(s.timestamp_s / 60)}:${String(s.timestamp_s % 60).padStart(2, '0')}`
                                : null;
                              return (
                                <a key={j} href={s.url} target="_blank" rel="noopener noreferrer" className="source-card" style={{ textDecoration: 'none' }}>
                                  <i className="fa-brands fa-youtube mr-1" style={{ color: '#ff0000' }} />{s.title}{time && <span className="ml-1 opacity-70">at {time}</span>}
                                </a>
                              );
                            }
                            return (
                              <div key={j} className="source-card">
                                <i className="fa-solid fa-file-pdf mr-1" style={{ color: 'var(--error-text)' }} />
                                {formatDocumentCitation(s)}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {m.created_at && (
                        <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}
                          className={`block mt-2 text-[0.58rem] ${m.role === 'user' ? 'text-right' : ''}`}
                          style={{ color: m.role === 'user' ? 'rgba(255,255,255,0.72)' : 'var(--text-muted)' }}>
                          {formatTimestamp(m.created_at)}
                        </time>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {sending && (
                <div id="typingIndicator" className="visible">
                  <div className="avatar avatar-ai"><i className="fa-solid fa-brain text-white text-[0.6rem]" /></div>
                  <div className="typing-dots"><div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" /></div>
                </div>
              )}

              <div id="inputBar">
                {!hasDocs && (
                  <div className="mb-2 px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-2"
                    style={{ background: 'rgba(234,179,8,0.12)', color: '#ca8a04', border: '1px solid rgba(234,179,8,0.3)' }}>
                    <i className="fa-solid fa-triangle-exclamation" /> No study materials uploaded yet. Upload a supported file for AI-powered answers.
                  </div>
                )}
                <div className="flex items-end gap-2.5">
                  <textarea id="msgInput" rows={1} value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    placeholder="Ask anything about your study materials…" />
                  <button id="sendBtn" onClick={sendMessage} disabled={sending || !input.trim() || !activeChat}>
                    <i className="fa-solid fa-paper-plane text-sm" />
                  </button>
                </div>
                <p className="text-[0.58rem] mt-1.5 text-center" style={{ color: 'var(--text-muted)' }}>
                  Teachable answers using only your uploaded documents.
                </p>
              </div>
              </>
              )}
            </>
          ) : (
            <div id="emptyState">
              <div className="w-20 h-20 rounded-3xl flex items-center justify-center mb-2 shadow-xl" style={{ background: 'var(--btn-primary-bg)' }}>
                <i className="fa-solid fa-brain text-white text-3xl" />
              </div>
              <h2 className="text-2xl font-extrabold" style={{ color: 'var(--text-primary)' }}>Welcome to Teachable</h2>
              <p className="text-sm max-w-sm" style={{ color: 'var(--text-secondary)' }}>
                Select a subject from the sidebar or create a new one to start studying with your personal AI tutor.
              </p>
              <button onClick={() => setModalOpen(true)} className="mt-2 px-6 py-3 rounded-full text-sm font-bold btn-primary transition">
                <i className="fa-solid fa-plus mr-2" />Create Your First Subject
              </button>
            </div>
          )}
        </div>
      </div>

      {/* NEW SUBJECT MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div className="w-full max-w-md rounded-3xl p-7 fade-in" style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-glass)', boxShadow: '0 24px 48px -8px rgba(0,0,0,0.30)' }}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{editingSubjectId ? 'Rename Subject' : 'New Subject'}</h3>
              <button onClick={() => setModalOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center btn-ghost">
                <i className="fa-solid fa-xmark text-sm" />
              </button>
            </div>
            <label className="block text-[0.68rem] font-black uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-secondary)' }}>Subject Name</label>
            <input value={newSubjectName} onChange={(e) => setNewSubjectName(e.target.value.replace(/[^a-zA-Z0-9 ]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSubject(); }}
              className="t-input w-full px-4 py-3 rounded-xl text-sm mb-4" placeholder="e.g. Mathematics, Physics, Law…" maxLength={40} />
            {modalError && <div className="mb-3 px-3 py-2 rounded-xl text-xs font-semibold t-error">{modalError}</div>}
            <button onClick={handleCreateSubject} className="w-full py-3 rounded-xl font-bold text-sm btn-primary transition">
              <i className={`fa-solid ${editingSubjectId ? 'fa-check' : 'fa-plus'} mr-2`} />{editingSubjectId ? 'Save Name' : 'Create Subject'}
            </button>
          </div>
        </div>
      )}

      {/* FILE MANAGER MODAL */}
      {progressOpen && activeSubject && (
        <ProgressPanel
          subjectId={activeSubject.id}
          subjectName={activeSubject.name}
          onClose={() => setProgressOpen(false)}
          onPracticeTopic={async (topic) => {
            setProgressOpen(false);
            await switchMode('practice');
            setInput(`Let's practice ${topic}. Ask me one question at a time and help me work through it.`);
          }}
        />
      )}

      {settingsOpen && activeSubject && (
        <SubjectSettingsPanel
          subjectId={activeSubject.id}
          subjectName={activeSubject.name}
          currentMode={activeSubject.knowledge_mode ?? null}
          onClose={() => setSettingsOpen(false)}
          onUpdated={(mode) => {
            const updated = { ...activeSubject, knowledge_mode: mode };
            setActiveSubject(updated);
            setSubjects((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          }}
        />
      )}

      {fileManagerOpen && activeSubject && (
        <DocumentManagerModal
          subject={activeSubject}
          onClose={() => setFileManagerOpen(false)}
          onToast={setToast}
          onDocumentsChange={(subjectId, documents) => {
            setActiveSubject((prev) => prev?.id === subjectId ? { ...prev, documents } : prev);
            setSubjects((prev) => prev.map((item) => item.id === subjectId ? { ...item, documents } : item));
          }}
        />
      )}

      {/* ERROR TOAST */}
      {toast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-full shadow-xl flex items-center gap-3 text-sm font-semibold fade-in max-w-[90vw]"
          style={{ background: 'var(--error-bg)', color: 'var(--error-text)', border: '1px solid var(--error-border)' }}>
          <i className="fa-solid fa-circle-exclamation shrink-0" />
          <span className="truncate">{toast}</span>
          <button onClick={() => setToast('')} className="shrink-0"><i className="fa-solid fa-xmark" /></button>
        </div>
      )}
    </div>
  );
}
