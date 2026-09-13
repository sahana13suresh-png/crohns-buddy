'use client';

import { useState, useMemo } from 'react';

export interface CalendarProps {
  selectedDate: string | null;
  onDateSelect: (date: string) => void;
  datesWithEntries: string[];
}

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Formats a Date as "YYYY-MM-DD" in local time.
 */
function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns today's date string in "YYYY-MM-DD" format.
 */
function getTodayString(): string {
  return toDateString(new Date());
}

/**
 * Checks if a date string represents a future date (after today).
 */
function isFutureDate(dateStr: string): boolean {
  const today = getTodayString();
  return dateStr > today;
}

export default function Calendar({
  selectedDate,
  onDateSelect,
  datesWithEntries,
}: CalendarProps) {
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  const today = getTodayString();
  const entriesSet = useMemo(() => new Set(datesWithEntries), [datesWithEntries]);

  // Calculate days to display in the grid
  const calendarDays = useMemo(() => {
    const firstDayOfMonth = new Date(viewYear, viewMonth, 1);
    const lastDayOfMonth = new Date(viewYear, viewMonth + 1, 0);
    const startDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sunday

    const days: Array<{ date: string; dayNum: number; isCurrentMonth: boolean }> = [];

    // Leading days from previous month
    const prevMonthLastDay = new Date(viewYear, viewMonth, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const dayNum = prevMonthLastDay - i;
      const date = new Date(viewYear, viewMonth - 1, dayNum);
      days.push({ date: toDateString(date), dayNum, isCurrentMonth: false });
    }

    // Days of current month
    for (let d = 1; d <= lastDayOfMonth.getDate(); d++) {
      const date = new Date(viewYear, viewMonth, d);
      days.push({ date: toDateString(date), dayNum: d, isCurrentMonth: true });
    }

    // Trailing days to fill out the grid (complete the last row)
    const remaining = 7 - (days.length % 7);
    if (remaining < 7) {
      for (let i = 1; i <= remaining; i++) {
        const date = new Date(viewYear, viewMonth + 1, i);
        days.push({ date: toDateString(date), dayNum: i, isCurrentMonth: false });
      }
    }

    return days;
  }, [viewYear, viewMonth]);

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  const goToPrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const goToNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleDayClick = (dateStr: string, isCurrentMonth: boolean) => {
    if (!isCurrentMonth) return;
    if (isFutureDate(dateStr)) return;
    onDateSelect(dateStr);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* Month navigation header */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={goToPrevMonth}
          aria-label="Previous month"
          className="rounded-full border border-transparent p-2.5 text-brand-700 transition-colors hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <h2 className="text-lg font-semibold text-brand-800">{monthLabel}</h2>

        <button
          type="button"
          onClick={goToNextMonth}
          aria-label="Next month"
          className="rounded-full border border-transparent p-2.5 text-brand-700 transition-colors hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADERS.map((day) => (
          <div
            key={day}
            className="py-2 text-center text-[0.68rem] font-semibold uppercase tracking-wider text-brand-800/45"
            aria-hidden="true"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label="Calendar">
        {calendarDays.map(({ date, dayNum, isCurrentMonth }) => {
          const isFuture = isFutureDate(date);
          const isToday = date === today;
          const isSelected = date === selectedDate;
          const hasEntry = entriesSet.has(date);

          // Determine styling based on state
          let dayClasses =
            'relative flex flex-col items-center justify-center w-full aspect-square rounded-xl text-sm transition-all ';

          if (!isCurrentMonth) {
            dayClasses += 'text-brand-800/20 cursor-default';
          } else if (isFuture) {
            dayClasses += 'text-brand-800/30 cursor-not-allowed bg-brand-50/50';
          } else if (isSelected) {
            dayClasses +=
              'bg-brand-600 text-white font-semibold cursor-pointer shadow-sm';
          } else if (isToday) {
            dayClasses +=
              'border-2 border-brand-500 text-brand-700 font-semibold cursor-pointer hover:bg-brand-50';
          } else {
            dayClasses +=
              'text-brand-800/70 cursor-pointer hover:bg-brand-50 hover:text-brand-800';
          }

          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-label={`${isCurrentMonth ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : ''}${hasEntry ? ', has entry' : ''}${isFuture && isCurrentMonth ? ', future date, cannot log entry' : ''}`}
              aria-selected={isSelected}
              aria-disabled={!isCurrentMonth || isFuture}
              disabled={!isCurrentMonth}
              onClick={() => handleDayClick(date, isCurrentMonth)}
              className={dayClasses}
              title={
                isFuture && isCurrentMonth
                  ? 'Cannot log entries for future dates'
                  : undefined
              }
            >
              <span>{dayNum}</span>

              {/* Entry indicator dot */}
              {hasEntry && isCurrentMonth && (
                <span
                  className={`absolute bottom-1 w-1.5 h-1.5 rounded-full ${
                    isSelected ? 'bg-white' : 'bg-brand-500'
                  }`}
                  aria-hidden="true"
                />
              )}

              {/* Future date indicator */}
              {isFuture && isCurrentMonth && (
                <span
                  className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-gray-300"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-brand-800/45">
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-brand-500" aria-hidden="true" />
          <span>Has entry</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-md border-2 border-brand-500" aria-hidden="true" />
          <span>Today</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-gray-300" aria-hidden="true" />
          <span>Future (locked)</span>
        </div>
      </div>
    </div>
  );
}
