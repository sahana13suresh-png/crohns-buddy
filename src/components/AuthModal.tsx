'use client';

import { useState } from 'react';
import { signIn, signUp } from '@/lib/auth';

interface AuthModalProps {
  mode: 'login' | 'signup';
  onClose: () => void;
  onSuccess: () => void;
  onSwitchMode: () => void;
}

export default function AuthModal({ mode, onClose, onSuccess, onSwitchMode }: AuthModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'signup') {
        if (!displayName.trim()) {
          setError('Please enter your name.');
          setLoading(false);
          return;
        }
        await signUp(email, password, displayName.trim());
      } else {
        await signIn(email, password);
      }
      onSuccess();
    } catch (err: unknown) {
      if (err instanceof Error) {
        const msg = err.message;
        if (msg.includes('email-already-in-use')) {
          setError('This email is already registered. Try logging in.');
        } else if (msg.includes('wrong-password') || msg.includes('invalid-credential')) {
          setError('Incorrect email or password.');
        } else if (msg.includes('user-not-found')) {
          setError('No account found with this email.');
        } else if (msg.includes('weak-password')) {
          setError('Password should be at least 6 characters.');
        } else if (msg.includes('invalid-email')) {
          setError('Please enter a valid email address.');
        } else if (msg.includes('not configured')) {
          setError('Authentication is not configured yet.');
        } else {
          setError('Something went wrong. Please try again.');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-800/40">
      <div className="bg-brand-50 w-full max-w-sm mx-4 p-10 relative border border-brand-800/10 rounded-sm">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-brand-800/40 hover:text-brand-800 text-lg transition-opacity duration-200"
          aria-label="Close"
        >
          ×
        </button>

        <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">
          {mode === 'login' ? 'Welcome back' : 'Get started'}
        </p>
        <h2 className="text-xl mb-8">
          {mode === 'login' ? 'Log In' : 'Create Account'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-5">
          {mode === 'signup' && (
            <div>
              <label htmlFor="auth-name" className="block text-xs uppercase tracking-widest text-brand-800/50 mb-2">
                Name
              </label>
              <input
                id="auth-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-full px-4 py-3 bg-transparent border border-brand-800/15 rounded-sm text-sm text-brand-800 placeholder:text-brand-800/30 focus:outline-none focus:border-brand-400 transition-colors duration-200"
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs uppercase tracking-widest text-brand-800/50 mb-2">
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full px-4 py-3 bg-transparent border border-brand-800/15 rounded-sm text-sm text-brand-800 placeholder:text-brand-800/30 focus:outline-none focus:border-brand-400 transition-colors duration-200"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs uppercase tracking-widest text-brand-800/50 mb-2">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
              className="w-full px-4 py-3 bg-transparent border border-brand-800/15 rounded-sm text-sm text-brand-800 placeholder:text-brand-800/30 focus:outline-none focus:border-brand-400 transition-colors duration-200"
            />
          </div>

          {error && (
            <p className="text-sm text-red-700/80">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full btn-primary mt-2"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Sign Up'}
          </button>
        </form>

        <p className="text-xs text-brand-800/40 mt-6">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={onSwitchMode}
            className="text-brand-400 hover:opacity-70 transition-opacity duration-200"
          >
            {mode === 'login' ? 'Sign Up' : 'Log In'}
          </button>
        </p>
      </div>
    </div>
  );
}
