import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AIChatInterface from './AIChatInterface';

describe('AIChatInterface', () => {
  const mockMealPlan = 'Breakfast: Oatmeal with banana\nLunch: Grilled chicken with rice';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the chat header', () => {
    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    expect(screen.getByText('Chat with AI')).toBeInTheDocument();
    expect(screen.getByText('Ask questions or request changes to your meal plan')).toBeInTheDocument();
  });

  it('renders the empty state message when no messages exist', () => {
    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    expect(
      screen.getByText(/Start a conversation to refine your meal plan/)
    ).toBeInTheDocument();
  });

  it('renders the input field and send button', () => {
    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    expect(screen.getByLabelText('Chat message input')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('disables the send button when input is empty', () => {
    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const sendButton = screen.getByLabelText('Send message');
    expect(sendButton).toBeDisabled();
  });

  it('enables the send button when input has text', () => {
    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    const sendButton = screen.getByLabelText('Send message');
    expect(sendButton).not.toBeDisabled();
  });

  it('displays user message immediately when sent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, reply: 'AI response' }),
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Can I swap the banana?' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(screen.getByText('Can I swap the banana?')).toBeInTheDocument();
  });

  it('clears the input after sending a message', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, reply: 'Sure!' }),
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(input.value).toBe('');
  });

  it('shows loading indicator while waiting for response', async () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        json: () => Promise.resolve({ success: true, reply: 'response' }),
      }), 1000))
    );

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(screen.getByText('AI is thinking...')).toBeInTheDocument();
  });

  it('displays AI response after successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, reply: 'Try blueberries instead!' }),
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Any substitute for banana?' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByText('Try blueberries instead!')).toBeInTheDocument();
    });
  });

  it('displays error message when API returns an error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'The service is busy. Please wait a moment and try again.' }),
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByText('The service is busy. Please wait a moment and try again.')).toBeInTheDocument();
    });
  });

  it('displays error message when fetch fails (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(
        screen.getByText('Failed to connect to the AI service. Please check your connection and try again.')
      ).toBeInTheDocument();
    });
  });

  it('provides a dismiss button on error that clears the error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByLabelText('Dismiss error and retry')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Dismiss error and retry'));

    expect(
      screen.queryByText('Failed to connect to the AI service. Please check your connection and try again.')
    ).not.toBeInTheDocument();
  });

  it('sends message on Enter key press', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, reply: 'Got it!' }),
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: 'Hello there' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('sends conversation history and meal plan to the API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, reply: 'Response 1' }),
    });
    global.fetch = mockFetch;

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');

    // Send first message
    fireEvent.change(input, { target: { value: 'First message' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByText('Response 1')).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'First message',
        conversationHistory: [],
        currentMealPlan: mockMealPlan,
      }),
    });
  });

  it('maintains conversation history across multiple messages', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, reply: `Response ${callCount}` }),
      });
    });

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');

    // Send first message
    fireEvent.change(input, { target: { value: 'Message 1' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByText('Response 1')).toBeInTheDocument();
    });

    // Send second message
    fireEvent.change(input, { target: { value: 'Message 2' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(screen.getByText('Response 2')).toBeInTheDocument();
    });

    // All messages should be visible (history maintained)
    expect(screen.getByText('Message 1')).toBeInTheDocument();
    expect(screen.getByText('Response 1')).toBeInTheDocument();
    expect(screen.getByText('Message 2')).toBeInTheDocument();
    expect(screen.getByText('Response 2')).toBeInTheDocument();
  });

  it('disables input and send button while loading', async () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        json: () => Promise.resolve({ success: true, reply: 'response' }),
      }), 1000))
    );

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(input).toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('does not send empty or whitespace-only messages', () => {
    global.fetch = vi.fn();

    render(<AIChatInterface currentMealPlan={mockMealPlan} />);
    const input = screen.getByLabelText('Chat message input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
