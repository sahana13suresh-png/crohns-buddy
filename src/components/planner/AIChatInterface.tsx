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
    <div className="mt-8 border border-blue-200 rounded-xl bg-white shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-blue-100 bg-blue-50 rounded-t-xl">
        <h3 className="text-lg font-semibold text-blue-800">
          Chat with AI
        </h3>
        <p className="text-sm text-blue-600">
          Ask questions or request changes to your meal plan
        </p>
      </div>

      {/* Message List */}
      <div
        className="px-4 py-4 space-y-4 max-h-96 overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {session.conversationHistory.length === 0 && !session.isLoading && (
          <p className="text-center text-gray-400 text-sm py-8">
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
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-800 border border-gray-200'
              }`}
            >
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {session.isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 border border-gray-200 rounded-lg px-4 py-2">
              <div className="flex items-center gap-2">
                <div className="flex gap-1" aria-label="AI is typing">
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-sm text-gray-500">AI is thinking...</span>
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
      <div className="px-4 py-3 border-t border-blue-100 bg-blue-50 rounded-b-xl">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your meal plan..."
            disabled={session.isLoading}
            className="flex-1 px-4 py-2 border border-blue-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Chat message input"
          />
          <button
            onClick={handleSendMessage}
            disabled={session.isLoading || !inputValue.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Send message"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
