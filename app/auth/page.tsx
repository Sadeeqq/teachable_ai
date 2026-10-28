'use client';

import { useState, useTransition } from 'react';
import ThemeSelect from '@/components/ThemeSelect';
import { signIn, signUp, signInWithGoogle } from './actions';

export default function AuthPage() {
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();

  function togglePw(id: string) {
    setShowPw((s) => ({ ...s, [id]: !s[id] }));
  }

  function handleLogin(formData: FormData) {
    setError('');
    startTransition(async () => {
      const res = await signIn(formData);
      if (res?.error) setError(res.error);
    });
  }

  function handleSignup(formData: FormData) {
    setError('');
    startTransition(async () => {
      const res = await signUp(formData);
      if (res?.error) setError(res.error);
    });
  }

  function handleGoogle() {
    setError('');
    startTransition(async () => {
      const res = await signInWithGoogle();
      if (res?.error) setError(res.error);
    });
  }

  return (
    <main className="font-sans antialiased min-h-screen flex items-center justify-center px-4 py-12 relative">
      {/* Ambient blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-[15%] -left-[10%] w-[55%] h-[55%] rounded-full opacity-30 blur-[130px]" style={{ background: 'var(--peak-active-border)' }} />
        <div className="absolute bottom-[-10%] -right-[10%] w-[45%] h-[55%] rounded-full opacity-20 blur-[130px]" style={{ background: 'var(--peak-active-border)' }} />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-xl" style={{ background: 'var(--btn-primary-bg)' }}>
            <i className="fa-solid fa-brain text-white text-2xl" />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight" style={{ color: 'var(--text-primary)' }}>Teachable</h1>
          <p className="text-sm mt-1.5 font-medium tagline">Your personal AI study tutor</p>
          <div className="mt-4 flex justify-center"><ThemeSelect /></div>
        </div>

        {/* Auth card */}
        <div className="rounded-3xl border shadow-2xl overflow-hidden" style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border-glass)' }}>
          {/* Tabs */}
          <div className="flex border-b" style={{ borderColor: 'var(--border-glass)' }}>
            <button onClick={() => { setTab('login'); setError(''); }}
              className={`flex-1 py-4 text-sm transition-all duration-200 focus:outline-none ${tab === 'login' ? 'tab-active' : 'tab-inactive'}`}>
              Sign In
            </button>
            <button onClick={() => { setTab('signup'); setError(''); }}
              className={`flex-1 py-4 text-sm transition-all duration-200 focus:outline-none ${tab === 'signup' ? 'tab-active' : 'tab-inactive'}`}>
              Create Account
            </button>
          </div>

          {error && (
            <div className="mx-6 mt-5 px-4 py-3 rounded-xl text-sm font-semibold t-error">{error}</div>
          )}

          {tab === 'login' ? (
            <form action={handleLogin} className="p-6 space-y-5">
              <div>
                <label className="auth-label" htmlFor="loginEmail">Email address</label>
                <input id="loginEmail" name="email" type="email" className="auth-input" placeholder="you@university.com" required autoComplete="email" />
              </div>
              <div>
                <label className="auth-label" htmlFor="loginPassword">Password</label>
                <div className="pw-wrapper">
                  <input id="loginPassword" name="password" type={showPw.login ? 'text' : 'password'} className="auth-input" placeholder="Your password" required autoComplete="current-password" />
                  <button type="button" className="pw-toggle" onClick={() => togglePw('login')} aria-label="Toggle password visibility">
                    <i className={`fa-solid ${showPw.login ? 'fa-eye-slash' : 'fa-eye'}`} />
                  </button>
                </div>
              </div>
              <button type="submit" className="auth-submit" disabled={pending}>
                {pending ? 'Please wait…' : 'Sign In to Teachable'}
              </button>
              <div className="or-divider">or continue with</div>
              <button type="button" className="google-btn" onClick={handleGoogle} disabled={pending}>
                <GoogleIcon /> Google
              </button>
              <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                No account yet?{' '}
                <button type="button" onClick={() => setTab('signup')} className="font-bold ml-1 underline" style={{ color: 'var(--peak-active-border)' }}>
                  Create one free
                </button>
              </p>
            </form>
          ) : (
            <form action={handleSignup} className="p-6 space-y-5">
              <div>
                <label className="auth-label" htmlFor="signupName">Full name</label>
                <input id="signupName" name="name" type="text" className="auth-input" placeholder="Your full name" required autoComplete="name" />
              </div>
              <div>
                <label className="auth-label" htmlFor="signupEmail">Email address</label>
                <input id="signupEmail" name="email" type="email" className="auth-input" placeholder="you@university.com" required autoComplete="email" />
              </div>
              <div>
                <label className="auth-label" htmlFor="signupPassword">Password</label>
                <div className="pw-wrapper">
                  <input id="signupPassword" name="password" type={showPw.signup ? 'text' : 'password'} className="auth-input" placeholder="At least 8 characters, with letters and numbers" required minLength={8} autoComplete="new-password" />
                  <button type="button" className="pw-toggle" onClick={() => togglePw('signup')} aria-label="Toggle password visibility">
                    <i className={`fa-solid ${showPw.signup ? 'fa-eye-slash' : 'fa-eye'}`} />
                  </button>
                </div>
                <p className="text-[0.62rem] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  Must be at least 8 characters and include both letters and numbers.
                </p>
              </div>
              <div>
                <label className="auth-label" htmlFor="signupConfirm">Confirm password</label>
                <div className="pw-wrapper">
                  <input id="signupConfirm" name="confirm" type={showPw.confirm ? 'text' : 'password'} className="auth-input" placeholder="Repeat your password" required minLength={8} autoComplete="new-password" />
                  <button type="button" className="pw-toggle" onClick={() => togglePw('confirm')} aria-label="Toggle password visibility">
                    <i className={`fa-solid ${showPw.confirm ? 'fa-eye-slash' : 'fa-eye'}`} />
                  </button>
                </div>
              </div>
              <button type="submit" className="auth-submit" disabled={pending}>
                {pending ? 'Please wait…' : 'Create My Account'}
              </button>
              <div className="or-divider">or continue with</div>
              <button type="button" className="google-btn" onClick={handleGoogle} disabled={pending}>
                <GoogleIcon /> Google
              </button>
              <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                Already have an account?{' '}
                <button type="button" onClick={() => setTab('login')} className="font-bold ml-1 underline" style={{ color: 'var(--peak-active-border)' }}>
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-xs mt-6" style={{ color: 'var(--text-muted)' }}>
          Your uploaded documents are private and never shared.
        </p>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
