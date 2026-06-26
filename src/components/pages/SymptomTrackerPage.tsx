'use client';

import { useState, useEffect, useCallback } from 'react';
import Calendar from '@/components/tracker/Calendar';
import TrackerForm from '@/components/tracker/TrackerForm';
import {
  getEntry,
  saveEntry,
  getDatesWithEntries,
  isStorageAvailable,
} from '@/lib/trackerStorage';
import { TrackerEntry } from '@/lib/types';

export default function SymptomTrackerPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [datesWithEntries, setDatesWithEntries] = useState<string[]>([]);
  const [currentEntry, setCurrentEntry] = useState<TrackerEntry | undefined>(undefined);
  const [storageAvailable, setStorageAvailable] = useState<boolean>(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  // Check localStorage availability on mount
  useEffect(() => {
    setStorageAvailable(isStorageAvailable());
  }, []);

  // Load dates with entries on mount and when storage is available
  useEffect(() => {
    if (storageAvailable) {
      setDatesWithEntries(getDatesWithEntries());
    }
  }, [storageAvailable]);

  // Load existing entry when a date is selected
  useEffect(() => {
    if (selectedDate && storageAvailable) {
      const entry = getEntry(selectedDate);
      setCurrentEntry(entry);
    } else {
      setCurrentEntry(undefined);
    }
    setSaveError(null);
    setSaveSuccess(false);
  }, [selectedDate, storageAvailable]);

  const handleDateSelect = useCallback((date: string) => {
    setSelectedDate(date);
    setSaveSuccess(false);
    setSaveError(null);
  }, []);

  const handleFormSubmit = useCallback(
    (entry: TrackerEntry) => {
      setSaveError(null);
      setSaveSuccess(false);

      try {
        saveEntry(entry);
        setCurrentEntry(entry);
        setDatesWithEntries(getDatesWithEntries());
        setSaveSuccess(true);
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === 'QuotaExceededError'
        ) {
          setSaveError(
            'Storage is full. Please clear old entries to continue tracking.'
          );
        } else {
          setSaveError('Failed to save entry. Please try again.');
        }
      }
    },
    []
  );

  const handleCancel = useCallback(() => {
    setSelectedDate(null);
  }, []);

  // Show error if localStorage is unavailable
  if (!storageAvailable) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="mb-6">Symptom Tracker</h1>
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-6 text-center"
          role="alert"
        >
          <p className="text-red-800 font-medium">
            Symptom tracking requires browser storage. Please enable it in your
            browser settings to use this feature.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <h1>Symptom Tracker</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Calendar Section */}
        <div>
          <Calendar
            selectedDate={selectedDate}
            onDateSelect={handleDateSelect}
            datesWithEntries={datesWithEntries}
          />
        </div>

        {/* Form Section */}
        <div>
          {saveError && (
            <div
              className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4"
              role="alert"
            >
              <p className="text-sm text-red-800">{saveError}</p>
            </div>
          )}

          {saveSuccess && (
            <div
              className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4"
              role="status"
            >
              <p className="text-sm text-green-800">
                Entry saved successfully!
              </p>
            </div>
          )}

          {selectedDate ? (
            <TrackerForm
              date={selectedDate}
              initialData={currentEntry}
              onSubmit={handleFormSubmit}
              onCancel={handleCancel}
            />
          ) : (
            <div className="rounded-lg border border-brand-200 bg-brand-50 p-6 text-center">
              <p className="text-brand-700">
                Select a date on the calendar to log or view your daily symptoms.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
