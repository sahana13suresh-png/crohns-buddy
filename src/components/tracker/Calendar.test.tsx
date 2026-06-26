import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Calendar from './Calendar';

// Fix "today" to 2024-06-15 for deterministic tests
const FIXED_TODAY = new Date(2024, 5, 15); // June 15, 2024

describe('Calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current month and year', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    expect(screen.getByText('June 2024')).toBeInTheDocument();
  });

  it('renders day-of-week headers', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    days.forEach((day) => {
      expect(screen.getByText(day)).toBeInTheDocument();
    });
  });

  it('renders all days of the current month', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    // June has 30 days
    for (let d = 1; d <= 30; d++) {
      expect(screen.getAllByText(String(d)).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('calls onDateSelect when a past date is clicked', () => {
    const onDateSelect = vi.fn();
    render(
      <Calendar selectedDate={null} onDateSelect={onDateSelect} datesWithEntries={[]} />
    );
    // Click June 10 (past date)
    const dayButtons = screen.getAllByRole('gridcell');
    const june10 = dayButtons.find(
      (btn) => btn.textContent?.includes('10') && btn.getAttribute('aria-label')?.includes('June')
    );
    expect(june10).toBeDefined();
    fireEvent.click(june10!);
    expect(onDateSelect).toHaveBeenCalledWith('2024-06-10');
  });

  it('calls onDateSelect when today is clicked', () => {
    const onDateSelect = vi.fn();
    render(
      <Calendar selectedDate={null} onDateSelect={onDateSelect} datesWithEntries={[]} />
    );
    // Click June 15 (today)
    const dayButtons = screen.getAllByRole('gridcell');
    const today = dayButtons.find(
      (btn) => btn.textContent?.includes('15') && btn.getAttribute('aria-label')?.includes('June 15')
    );
    expect(today).toBeDefined();
    fireEvent.click(today!);
    expect(onDateSelect).toHaveBeenCalledWith('2024-06-15');
  });

  it('does NOT call onDateSelect when a future date is clicked', () => {
    const onDateSelect = vi.fn();
    render(
      <Calendar selectedDate={null} onDateSelect={onDateSelect} datesWithEntries={[]} />
    );
    // Click June 20 (future date)
    const dayButtons = screen.getAllByRole('gridcell');
    const future = dayButtons.find(
      (btn) => btn.textContent?.includes('20') && btn.getAttribute('aria-label')?.includes('June 20')
    );
    expect(future).toBeDefined();
    fireEvent.click(future!);
    expect(onDateSelect).not.toHaveBeenCalled();
  });

  it('shows future dates as disabled', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const dayButtons = screen.getAllByRole('gridcell');
    const future = dayButtons.find(
      (btn) => btn.textContent?.includes('20') && btn.getAttribute('aria-label')?.includes('June 20')
    );
    expect(future).toBeDefined();
    expect(future).toHaveAttribute('aria-disabled', 'true');
  });

  it('visually distinguishes days with entries (dot indicator)', () => {
    const { container } = render(
      <Calendar
        selectedDate={null}
        onDateSelect={() => {}}
        datesWithEntries={['2024-06-10', '2024-06-12']}
      />
    );
    // Days with entries should have an indicator dot (small span inside the button)
    const dayButtons = screen.getAllByRole('gridcell');
    const june10 = dayButtons.find(
      (btn) => btn.textContent?.includes('10') && btn.getAttribute('aria-label')?.includes('has entry')
    );
    expect(june10).toBeDefined();
    // Check the dot element exists inside
    const dot = june10!.querySelector('span.rounded-full');
    expect(dot).toBeTruthy();
  });

  it('highlights today with a border', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const dayButtons = screen.getAllByRole('gridcell');
    const todayBtn = dayButtons.find(
      (btn) => btn.textContent?.includes('15') && btn.getAttribute('aria-label')?.includes('June 15')
    );
    expect(todayBtn).toBeDefined();
    expect(todayBtn!.className).toContain('border-brand-500');
  });

  it('highlights selected date', () => {
    render(
      <Calendar
        selectedDate="2024-06-10"
        onDateSelect={() => {}}
        datesWithEntries={[]}
      />
    );
    const dayButtons = screen.getAllByRole('gridcell');
    const selected = dayButtons.find(
      (btn) => btn.getAttribute('aria-selected') === 'true'
    );
    expect(selected).toBeDefined();
    expect(selected!.className).toContain('bg-brand-600');
  });

  it('navigates to previous month', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const prevBtn = screen.getByLabelText('Previous month');
    fireEvent.click(prevBtn);
    expect(screen.getByText('May 2024')).toBeInTheDocument();
  });

  it('navigates to next month', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const nextBtn = screen.getByLabelText('Next month');
    fireEvent.click(nextBtn);
    expect(screen.getByText('July 2024')).toBeInTheDocument();
  });

  it('shows a tooltip on future dates indicating entry cannot be logged', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    const dayButtons = screen.getAllByRole('gridcell');
    const future = dayButtons.find(
      (btn) => btn.textContent?.includes('20') && btn.getAttribute('aria-label')?.includes('future date')
    );
    expect(future).toBeDefined();
    expect(future!.getAttribute('title')).toBe('Cannot log entries for future dates');
  });

  it('renders a legend explaining indicators', () => {
    render(
      <Calendar selectedDate={null} onDateSelect={() => {}} datesWithEntries={[]} />
    );
    expect(screen.getByText('Has entry')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Future (locked)')).toBeInTheDocument();
  });
});
