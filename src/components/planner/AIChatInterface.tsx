'use client';

import { useState, useRef, useEffect } from 'react';
import { ChatSession } from '@/lib/types';

interface AIChatInterfaceProps {
  currentMealPlan: string;
}

/**
 * AIChatInterface — Conversation UI for refining meal plans with AI.
 *
 * Validates: Requirements 6.3, 6.4, 6.5, 6.6
 *
 * - Displays chat conversation below/adjacent to the meal plan
 * - Maintains conversation history in client state for the session duration
 * - Sends messages to /api/chat with full history context
 * - Displays AI responses and handles loading/error states
 */
export default function AIChatInterface({ currentMealPlan }: AIChatInterfaceProps) {
  const [session, setSession] = useState<ChatSession>({
    conversationHistory: [],
    currentMealPlan,
    isLoading: false,
  });
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to the bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.conversationHistory]);

  const handleSendMessage = async () => {
    const trimmedMessage = inputValue.trim();
    if (!trimmedMessage || session.isLoading) return;

    // Clear error and input
    setError(null);
    setInputValue('');

    // Add user message to history immediately
    const updatedHistory = [
      ...session.conversationHistory,
      { role: 'user' as const, content: trimmedMessage },
    ];

    setSession((prev) => ({
      ...prev,
      conversationHistory: updatedHistory,
      isLoading: true,
    }));

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmedMessage,
          conversationHistory: session.conversationHistory,
          currentMealPlan,
        }),
      });

      const data = await response.json();

      if (!data.success || !data.reply) {
        const errorMessage =
          data.error || 'The AI service is temporarily unavailable. Please try again later.';
        setError(errorMessage);
        setSession((prev) => ({
          ...prev,
          isLoading: false,
        }));
        return;
      }

      // Append AI response to conversation history
      setSession((prev) => ({
        ...prev,
        conversationHistory: [
          ...updatedHistory,
          { role: 'assistant' as const, content: data.reply },
        ],
        isLoading: false,
      }));
    } catch {
      setError('Failed to connect to the AI service. Please check your connection and try again.');
      setSession((prev) => ({
        ...prev,
        isLoading: false,
      }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleRetry = () => {
    setError(null);
    // Focus the input so the user can re-type or re-send
    inputRef.current?.focus();
  };

  return (
    <div className="mt-8 overflow-hidden rounded-2xl border border-brand-800/10 bg-white shadow-[0_18px_50px_-35px_rgba(15,34,64,0.4)]">
      {/* Header */}
      <div className="border-b border-brand-800/10 bg-brand-800 px-5 py-4">
        <h3 className="text-lg font-semibold text-white">
          Chat with AI
        </h3>
        <p className="text-sm text-white/65">
          Ask questions or request changes to your meal plan
        </p>
      </div>

      {/* Message List */}
      <div
        className="max-h-96 space-y-4 overflow-y-auto bg-brand-50/30 px-5 py-5"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {session.conversationHistory.length === 0 && !session.isLoading && (
          <p className="mx-auto max-w-md py-8 text-center text-sm leading-relaxed text-brand-800/40">
            Start a conversation to refine your meal plan. Try asking about substitutions,
            portion adjustments, or new meal ideas.
          </p>
        )}

        {session.conversationHistory.map((msg, index) => (
          <div
            key={index}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                msg.role === 'user'
                  ? 'rounded-br-md bg-brand-700 text-white'
                  : 'rounded-bl-md border border-brand-800/10 bg-white text-brand-800 shadow-sm'
              }`}
            >
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {session.isLoading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md border border-brand-800/10 bg-white px-4 py-2.5 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="flex gap-1" aria-label="AI is typing">
                  <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-sm text-brand-800/45">AI is thinking...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error Display */}
      {error && (
        <div className="mx-4 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={handleRetry}
            className="ml-3 text-sm font-medium text-red-600 hover:text-red-800 underline flex-shrink-0"
            aria-label="Dismiss error and retry"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-brand-800/10 bg-white px-4 py-4">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your meal plan..."
            disabled={session.isLoading}
            className="field-control flex-1 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Chat message input"
          />
          <button
            onClick={handleSendMessage}
            disabled={session.isLoading || !inputValue.trim()}
            className="btn-primary px-5 py-2.5 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send message"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
