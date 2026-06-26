'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ForumMessage, ModerateResponse } from '@/lib/types';
import { subscribeToForumMessages, postForumMessage } from '@/lib/firebase';
import ChatMessage from './ChatMessage';

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 50;
const MESSAGE_MIN = 1;
const MESSAGE_MAX = 2000;
const SESSION_STORAGE_KEY = 'crohns-buddy-forum-displayName';

/**
 * ChatForum is the community chat component that renders on the Resources page.
 * It allows users to browse messages without a display name, but requires one to post.
 * Messages are loaded in real-time from Firestore in reverse chronological order.
 */
export default function ChatForum() {
  // Display name state
  const [displayName, setDisplayName] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [displayNameError, setDisplayNameError] = useState('');

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

  // Restore display name from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored && stored.length >= DISPLAY_NAME_MIN && stored.length <= DISPLAY_NAME_MAX) {
        setDisplayName(stored);
      }
    } catch {
      // sessionStorage unavailable, no-op
    }
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
    } catch (error) {
      setConnectionError('Unable to connect to the community chat. Please check your connection.');
      setIsLoading(false);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  // ─── Display Name Handlers ─────────────────────────────────────────────────

  function handleDisplayNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayNameInput.trim();

    if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
      setDisplayNameError(`Display name must be between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters.`);
      return;
    }

    setDisplayName(trimmed);
    setDisplayNameError('');

    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, trimmed);
    } catch {
      // sessionStorage unavailable, no-op
    }
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

    const validationError = validateMessage(messageInput);
    if (validationError) {
      setMessageError(validationError);
      return;
    }

    setMessageError('');
    setIsSending(true);

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

      {/* Display Name Prompt (shown if no display name set) */}
      {!displayName && (
        <form onSubmit={handleDisplayNameSubmit} className="space-y-3">
          <label htmlFor="display-name-input" className="block text-sm font-medium text-gray-700">
            Enter a display name to join the conversation
          </label>
          <div className="flex gap-2">
            <input
              id="display-name-input"
              type="text"
              value={displayNameInput}
              onChange={(e) => {
                setDisplayNameInput(e.target.value);
                setDisplayNameError('');
              }}
              placeholder="Your display name (1-50 characters)"
              maxLength={DISPLAY_NAME_MAX}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              aria-describedby={displayNameError ? 'display-name-error' : undefined}
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
            >
              Join
            </button>
          </div>
          {displayNameError && (
            <p id="display-name-error" className="text-sm text-red-600" role="alert">
              {displayNameError}
            </p>
          )}
        </form>
      )}

      {/* Message Input (shown only if display name is set) */}
      {displayName && (
        <form onSubmit={handleMessageSubmit} className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>Posting as</span>
            <span className="font-semibold text-brand-700">{displayName}</span>
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
