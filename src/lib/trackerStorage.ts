/**
 * Symptom Tracker localStorage persistence utilities.
 *
 * Stores TrackerEntry objects keyed by date string in localStorage
 * under the key "crohns-buddy-tracker-entries".
 */

import { TrackerEntry } from './types';

const STORAGE_KEY = 'crohns-buddy-tracker-entries';

export type TrackerEntries = Record<string, TrackerEntry>;

/**
 * Reads all tracker entries from localStorage.
 * Returns an empty record if no entries exist or localStorage is unavailable.
 */
export function getAllEntries(): TrackerEntries {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as TrackerEntries;
  } catch {
    return {};
  }
}

/**
 * Gets a single tracker entry for a specific date.
 * Returns undefined if no entry exists for that date.
 */
export function getEntry(date: string): TrackerEntry | undefined {
  const entries = getAllEntries();
  return entries[date];
}

/**
 * Saves a tracker entry for a specific date.
 * Overwrites any existing entry for that date.
 * Throws if localStorage is full (QuotaExceededError).
 */
export function saveEntry(entry: TrackerEntry): void {
  const entries = getAllEntries();
  entries[entry.date] = entry;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Deletes a tracker entry for a specific date.
 * No-op if the entry doesn't exist.
 */
export function deleteEntry(date: string): void {
  const entries = getAllEntries();
  delete entries[date];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Removes every tracker entry held in the browser on this device.
 *
 * Used by the Account_Deletion_Flow, which clears the device-local entries
 * after the Account is removed (Requirement 11.3). It never throws: a storage
 * write denied by the browser leaves the entries where they were, and the
 * deletion flow has already removed the Account by the time it is called, so
 * there is nothing useful to abort.
 */
export function clearAllEntries(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage denied. Nothing further to do here.
  }
}

/**
 * Returns an array of date strings that have entries.
 * Useful for highlighting days on the calendar.
 */
export function getDatesWithEntries(): string[] {
  const entries = getAllEntries();
  return Object.keys(entries);
}

/**
 * Checks whether localStorage is available and writable.
 */
export function isStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const testKey = '__crohns_buddy_storage_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}
