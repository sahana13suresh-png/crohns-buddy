import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ChatMessage, { formatRelativeTime } from './ChatMessage';
import { ForumMessage } from '@/lib/types';

describe('ChatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('displays a normal message with author name, timestamp, and content', () => {
    const message: ForumMessage = {
      id: '1',
      displayName: 'Alice',
      content: 'Hello everyone!',
      removed: false,
      timestamp: new Date('2024-06-15T11:55:00Z'),
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    expect(screen.getByText('Hello everyone!')).toBeInTheDocument();
  });

  it('displays a removed message with default removal notice', () => {
    const message: ForumMessage = {
      id: '2',
      displayName: 'Bob',
      content: 'This should be hidden',
      removed: true,
      timestamp: new Date('2024-06-15T11:30:00Z'),
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('30 minutes ago')).toBeInTheDocument();
    expect(
      screen.getByText('This message was removed for violating community guidelines')
    ).toBeInTheDocument();
    expect(screen.queryByText('This should be hidden')).not.toBeInTheDocument();
  });

  it('displays a removed message with a custom removal notice', () => {
    const message: ForumMessage = {
      id: '3',
      displayName: 'Carol',
      content: 'Original content hidden',
      removed: true,
      removalNotice: 'This message was removed for hate speech.',
      timestamp: new Date('2024-06-15T10:00:00Z'),
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText('Carol')).toBeInTheDocument();
    expect(
      screen.getByText('This message was removed for hate speech.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Original content hidden')).not.toBeInTheDocument();
  });

  it('uses muted/gray styling for removed messages', () => {
    const message: ForumMessage = {
      id: '4',
      displayName: 'Dan',
      content: 'removed content',
      removed: true,
      timestamp: new Date('2024-06-15T11:00:00Z'),
    };

    const { container } = render(<ChatMessage message={message} />);
    const wrapper = container.firstChild as HTMLElement;

    expect(wrapper.className).toContain('bg-gray-100');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps less than a minute ago', () => {
    const date = new Date('2024-06-15T11:59:30Z');
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns "1 minute ago" for exactly one minute', () => {
    const date = new Date('2024-06-15T11:59:00Z');
    expect(formatRelativeTime(date)).toBe('1 minute ago');
  });

  it('returns "X minutes ago" for timestamps less than an hour ago', () => {
    const date = new Date('2024-06-15T11:45:00Z');
    expect(formatRelativeTime(date)).toBe('15 minutes ago');
  });

  it('returns "1 hour ago" for exactly one hour', () => {
    const date = new Date('2024-06-15T11:00:00Z');
    expect(formatRelativeTime(date)).toBe('1 hour ago');
  });

  it('returns "X hours ago" for timestamps less than a day ago', () => {
    const date = new Date('2024-06-15T06:00:00Z');
    expect(formatRelativeTime(date)).toBe('6 hours ago');
  });

  it('returns "yesterday" for timestamps one day ago', () => {
    const date = new Date('2024-06-14T12:00:00Z');
    expect(formatRelativeTime(date)).toBe('yesterday');
  });

  it('returns "X days ago" for timestamps less than a week ago', () => {
    const date = new Date('2024-06-12T12:00:00Z');
    expect(formatRelativeTime(date)).toBe('3 days ago');
  });

  it('returns a formatted date for timestamps older than a week', () => {
    const date = new Date('2024-05-01T12:00:00Z');
    const result = formatRelativeTime(date);
    expect(result).toContain('May');
    expect(result).toContain('1');
  });
});
