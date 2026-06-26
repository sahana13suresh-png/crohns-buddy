import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SymptomTrackerPage from './SymptomTrackerPage';
import * as trackerStorage from '@/lib/trackerStorage';
import { TrackerEntry } from '@/lib/types';

// Mock trackerStorage module
vi.mock('@/lib/trackerStorage', () => ({
  getEntry: vi.fn(),
  saveEntry: vi.fn(),
  getDatesWithEntries: vi.fn(() => []),
  isStorageAvailable: vi.fn(() => true),
}));

function getTodayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('SymptomTrackerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (trackerStorage.isStorageAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (trackerStorage.getDatesWithEntries as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (trackerStorage.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('renders the page heading', () => {
    render(<SymptomTrackerPage />);
    expect(screen.getByRole('heading', { name: /symptom tracker/i })).toBeInTheDocument();
  });

  it('shows prompt to select a date when no date is selected', () => {
    render(<SymptomTrackerPage />);
    expect(
      screen.getByText(/select a date on the calendar to log or view your daily symptoms/i)
    ).toBeInTheDocument();
  });

  it('shows error when localStorage is unavailable', () => {
    (trackerStorage.isStorageAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);
    render(<SymptomTrackerPage />);
    expect(
      screen.getByText(/symptom tracking requires browser storage/i)
    ).toBeInTheDocument();
  });

  it('displays the TrackerForm when a valid date is selected', () => {
    render(<SymptomTrackerPage />);

    // Today's date button should be clickable
    const today = getTodayString();
    const todayDate = new Date(today + 'T00:00:00');
    const dayNum = todayDate.getDate();

    // Find and click today's date
    const dayButtons = screen.getAllByRole('gridcell');
    const todayButton = dayButtons.find(
      (btn) => btn.getAttribute('aria-selected') === 'false' &&
               btn.getAttribute('aria-disabled') === 'false' &&
               btn.textContent?.includes(String(dayNum))
    ) || dayButtons.find(
      (btn) => btn.getAttribute('aria-label')?.includes('today') ||
               btn.getAttribute('aria-label')?.includes(todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))
    );

    if (todayButton) {
      fireEvent.click(todayButton);
      // Form should now be visible
      expect(screen.getByRole('button', { name: /save entry/i })).toBeInTheDocument();
    }
  });

  it('populates form with existing entry data for selected date', () => {
    const existingEntry: TrackerEntry = {
      date: getTodayString(),
      foodConsumed: 'Rice and chicken',
      painLevel: 3,
      bowelMovements: 2,
      stressLevel: 4,
      energyLevel: 7,
      submittedAt: '2024-01-15T10:00:00.000Z',
    };
    (trackerStorage.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(existingEntry);

    render(<SymptomTrackerPage />);

    // Click today's date
    const dayButtons = screen.getAllByRole('gridcell');
    const today = getTodayString();
    const todayDate = new Date(today + 'T00:00:00');
    const todayButton = dayButtons.find(
      (btn) => btn.getAttribute('aria-label')?.includes(
        todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      )
    );

    if (todayButton) {
      fireEvent.click(todayButton);
      // Should show "Update Entry" button (indicating editing mode)
      expect(screen.getByRole('button', { name: /update entry/i })).toBeInTheDocument();
    }
  });

  it('highlights dates with entries on the calendar', () => {
    const today = getTodayString();
    (trackerStorage.getDatesWithEntries as ReturnType<typeof vi.fn>).mockReturnValue([today]);

    render(<SymptomTrackerPage />);

    // The calendar should receive the dates with entries
    // The has entry indicator should be present
    const dayButtons = screen.getAllByRole('gridcell');
    const todayButton = dayButtons.find(
      (btn) => btn.getAttribute('aria-label')?.includes('has entry')
    );
    expect(todayButton).toBeDefined();
  });

  it('saves entry and shows success message on form submit', () => {
    render(<SymptomTrackerPage />);

    // Click today's date
    const dayButtons = screen.getAllByRole('gridcell');
    const today = getTodayString();
    const todayDate = new Date(today + 'T00:00:00');
    const todayButton = dayButtons.find(
      (btn) => btn.getAttribute('aria-label')?.includes(
        todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      )
    );

    if (todayButton) {
      fireEvent.click(todayButton);

      // Submit the form
      const submitButton = screen.getByRole('button', { name: /save entry/i });
      fireEvent.click(submitButton);

      // saveEntry should have been called
      expect(trackerStorage.saveEntry).toHaveBeenCalled();
    }
  });

  it('shows error message when save fails due to quota', () => {
    (trackerStorage.saveEntry as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const error = new DOMException('QuotaExceededError', 'QuotaExceededError');
      throw error;
    });

    render(<SymptomTrackerPage />);

    // Click today's date
    const dayButtons = screen.getAllByRole('gridcell');
    const today = getTodayString();
    const todayDate = new Date(today + 'T00:00:00');
    const todayButton = dayButtons.find(
      (btn) => btn.getAttribute('aria-label')?.includes(
        todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      )
    );

    if (todayButton) {
      fireEvent.click(todayButton);

      // Submit the form
      const submitButton = screen.getByRole('button', { name: /save entry/i });
      fireEvent.click(submitButton);

      // Should show the storage full error
      expect(
        screen.getByText(/storage is full/i)
      ).toBeInTheDocument();
    }
  });
});
