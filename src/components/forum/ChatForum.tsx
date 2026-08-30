'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ForumMessage, ModerateResponse } from '@/lib/types';
import { subscribeToForumMessages, postForumMessage } from '@/lib/firebase';
import { AuthSession, onAuthChange, signOut } from '@/lib/auth';
import GoogleSignInButton, {
  configuredIdentityProviders,
} from '@/components/auth/GoogleSignInButton';
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
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

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

  // Whether this deployment configures any Identity_Provider to sign in with.
  const hasIdentityProvider = configuredIdentityProviders().length > 0;

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthChange((currentSession) => {
      setSession(currentSession);
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
    if (!session) return;

    const validationError = validateMessage(messageInput);
    if (validationError) {
      setMessageError(validationError);
      return;
    }

    setMessageError('');
    setIsSending(true);

    // `deriveDisplayName` already guarantees a non-empty value; the fallbacks
    // remain only so a hand-built session cannot post as an empty author.
    const displayName = session.displayName || session.email || 'Anonymous';

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

      {/*
        Sign In Section (shown if not authenticated). The control itself, and the
        message for every provider outcome, come from the shared
        `GoogleSignInButton` so the forum and the account modal cannot drift
        apart. It is driven by the same `NEXT_PUBLIC_AUTH_PROVIDERS` list, so the
        prompt is omitted entirely when no Identity_Provider is configured —
        posting needs one, and an inert control would explain nothing.
      */}
      {!authLoading && !session && hasIdentityProvider && (
        <div className="space-y-3 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-600">
            Sign in to join the conversation
          </p>
          <GoogleSignInButton />
        </div>
      )}

      {/* Message Input (shown only if signed in) */}
      {session && (
        <form onSubmit={handleMessageSubmit} className="space-y-3 border-t border-gray-200 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>Posting as</span>
              <span className="font-semibold text-brand-700">
                {session.displayName || session.email}
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
