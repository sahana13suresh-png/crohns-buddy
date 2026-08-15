'use client';

import React, { useState, useEffect, useRef } from 'react';
import { User } from 'firebase/auth';
import { ForumMessage, ModerateResponse } from '@/lib/types';
import {
  subscribeToForumMessages,
  postForumMessage,
  signInWithGoogle,
  signOut,
  onAuthChange,
} from '@/lib/firebase';
import ChatMessage from './ChatMessage';

const MESSAGE_MIN = 1;
const MESSAGE_MAX = 2000;

/**
 * ChatForum is the community chat component that renders on the Resources page.
 * Users can browse messages without signing in, but must sign in with Google to post.
 * Messages are loaded in real-time from Firestore in reverse chronological order.
 */
export default function ChatForum() {
  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [signInError, setSignInError] = useState('');

  // Message input state
  const [messageInput, setMessageInput] = useState('');
  const [messageError, setMessageError] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Messages from Firestore
  const [messages, setMessages] = useState<ForumMessage[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Ref for scrolling
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthChange((currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  // Subscribe to real-time Firestore messages
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = subscribeToForumMessages((updatedMessages) => {
        setMessages(updatedMessages);
        setIsLoading(false);
        setConnectionError('');
      });
    } catch {
      setConnectionError('Unable to connect to the community chat. Please check your connection.');
      setIsLoading(false);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  // ─── Auth Handlers ─────────────────────────────────────────────────────────

  async function handleGoogleSignIn() {
    setSignInError('');
    const result = await signInWithGoogle();
    if (!result) {
      setSignInError('Sign-in failed. Please try again.');
    }
  }

  async function handleSignOut() {
    await signOut();
  }

  // ─── Message Handlers ──────────────────────────────────────────────────────

  function validateMessage(text: string): string {
    if (text.length < MESSAGE_MIN) {
      return 'Message cannot be empty.';
    }
    if (text.length > MESSAGE_MAX) {
      return `Message must be ${MESSAGE_MAX} characters or fewer.`;
    }
    return '';
  }

  async function handleMessageSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;

    const validationError = validateMessage(messageInput);
    if (validationError) {
      setMessageError(validationError);
      return;
    }

    setMessageError('');
    setIsSending(true);

    const displayName = user.displayName || user.email || 'Anonymous';

    try {
      // Step 1: Call moderation API
      const moderateRes = await fetch('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: messageInput }),
      });

      const moderateData: ModerateResponse = await moderateRes.json();

      // Step 2: Write to Firestore based on moderation result
      if (moderateData.approved) {
        await postForumMessage(displayName, messageInput, false);
      } else {
        await postForumMessage(displayName, messageInput, true, moderateData.reason);
      }

      // Clear input on success
      setMessageInput('');
      setMessageError('');
    } catch {
      setMessageError('Failed to send message. Please try again.');
    } finally {
      setIsSending(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full space-y-6">
      {/* Connection Error */}
      {connectionError && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700" role="alert">
          {connectionError}
        </div>
      )}

      {/* Messages List */}
      <div className="space-y-3 max-h-96 overflow-y-auto" aria-label="Forum messages">
        {isLoading && (
          <p className="text-center text-sm text-gray-500 py-4">Loading messages...</p>
        )}

        {!isLoading && messages.length === 0 && !connectionError && (
          <p className="text-center text-sm text-gray-500 py-4">
            No messages yet. Be the first to say hello!
          </p>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Sign In Section (shown if not authenticated) */}
      {!authLoading && !user && (
        <div className="space-y-3 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-600">
            Sign in to join the conversation
          </p>
          <button
            onClick={handleGoogleSignIn}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
          {signInError && (
            <p className="text-sm text-red-600" role="alert">{signInError}</p>
          )}
        </div>
      )}

      {/* Message Input (shown only if signed in) */}
      {user && (
        <form onSubmit={handleMessageSubmit} className="space-y-3 border-t border-gray-200 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              {user.photoURL && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.photoURL}
                  alt=""
                  className="w-6 h-6 rounded-full"
                />
              )}
              <span>Posting as</span>
              <span className="font-semibold text-brand-700">
                {user.displayName || user.email}
              </span>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Sign out
            </button>
          </div>
          <div className="flex gap-2">
            <input
              id="message-input"
              type="text"
              value={messageInput}
              onChange={(e) => {
                setMessageInput(e.target.value);
                if (messageError) {
                  setMessageError('');
                }
              }}
              placeholder="Type your message..."
              maxLength={MESSAGE_MAX}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              aria-describedby={messageError ? 'message-error' : undefined}
              disabled={isSending}
            />
            <button
              type="submit"
              disabled={isSending}
              className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>
          {messageError && (
            <p id="message-error" className="text-sm text-red-600" role="alert">
              {messageError}
            </p>
          )}
          <p className="text-xs text-gray-400">
            {messageInput.length}/{MESSAGE_MAX} characters
          </p>
        </form>
      )}
    </div>
  );
}
