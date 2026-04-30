import React, { useState } from 'react';
import { useAuth } from '../services/auth';
import { NoahLogo } from '../App';

export default function SignInScreen() {
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async (fn) => {
    setError('');
    setLoading(true);
    try { await fn(); }
    catch (e) { setError(e.message.replace('Firebase: ', '').replace(/ \(auth\/.*\)/, '')); }
    finally { setLoading(false); }
  };

  return (
    <div className="w-full h-screen flex items-center justify-center app-bg select-none">
      <div
        className="glass rounded-2xl p-8 w-80 flex flex-col gap-6 slide-up"
        style={{ boxShadow: '0 8px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(22,163,74,0.1)' }}
      >
        <div className="flex flex-col items-center gap-3">
          <NoahLogo size={52} pulse />
          <div className="text-center">
            <h1 className="text-xl font-semibold text-white tracking-tight">Welcome to Noah</h1>
            <p className="text-xs text-white/35 mt-0.5">Your AI desktop companion</p>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <input
            className="noah-input px-3.5 py-2.5 text-sm w-full"
            type="email"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run(() => signIn(email, password))}
          />
          <input
            className="noah-input px-3.5 py-2.5 text-sm w-full"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run(() => signIn(email, password))}
          />
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2 text-center">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          <button
            className="btn-green py-2.5 text-sm w-full"
            disabled={loading || !email || !password}
            onClick={() => run(() => signIn(email, password))}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/6" />
            <span className="text-xs text-white/25">or</span>
            <div className="flex-1 h-px bg-white/6" />
          </div>

          <button
            className="btn-ghost py-2.5 text-sm w-full flex items-center justify-center gap-2"
            disabled={loading}
            onClick={() => run(signInWithGoogle)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}
