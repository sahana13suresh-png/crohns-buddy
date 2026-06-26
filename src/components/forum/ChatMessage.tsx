'use client';

import React from 'react';
import { ForumMessage } from '@/lib/types';

interface ChatMessageProps {
  message: ForumMessage;
}

/**
 * Formats a timestamp into a human-readable relative time string.
 * Shows "just now", "X minutes ago", "X hours ago", "yesterday",
 * or a formatted date for older messages.
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
  } else if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  }
}

/**
 * ChatMessage displays a single forum message.
 * If the message has been removed by moderation, it shows a
 * community guidelines violation notice instead of the original content.
 */
export default function ChatMessage({ message }: ChatMessageProps) {
  const { displayName, content, removed, removalNotice, timestamp } = message;

  if (removed) {
    return (
      <div className="px-4 py-3 rounded-lg bg-gray-100 border border-gray-200">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-bold text-sm text-gray-400">{displayName}</span>
          <span className="text-xs text-gray-400">
            {formatRelativeTime(timestamp)}
          </span>
        </div>
        <p className="text-sm text-gray-500 italic">
          {removalNotice || 'This message was removed for violating community guidelines'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 rounded-lg bg-white border border-brand-100">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-bold text-sm text-brand-800">{displayName}</span>
        <span className="text-xs text-gray-500">
          {formatRelativeTime(timestamp)}
        </span>
      </div>
      <p className="text-sm text-gray-800 whitespace-pre-wrap">{content}</p>
    </div>
  );
}

export { formatRelativeTime };
