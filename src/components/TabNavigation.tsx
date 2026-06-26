'use client';

import { useRef, useCallback, KeyboardEvent } from 'react';

export type TabId = 'welcome' | 'about' | 'tracker' | 'planner' | 'resources';

export interface Tab {
  id: TabId;
  label: string;
}

export const TABS: Tab[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'about', label: "About Crohn's" },
  { id: 'tracker', label: 'Symptom Tracker' },
  { id: 'planner', label: 'AI Meal Planner' },
  { id: 'resources', label: 'Resources' },
];

export interface TabNavigationProps {
  activeTab: TabId;
  onTabChange: (tabId: TabId) => void;
}

export default function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setTabRef = useCallback((el: HTMLButtonElement | null, index: number) => {
    tabRefs.current[index] = el;
  }, []);

  const focusTab = (index: number) => {
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let newIndex: number | null = null;

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        newIndex = (index + 1) % TABS.length;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        newIndex = (index - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        e.preventDefault();
        newIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        newIndex = TABS.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onTabChange(TABS[index].id);
        return;
      default:
        return;
    }

    if (newIndex !== null) {
      focusTab(newIndex);
    }
  };

  return (
    <nav aria-label="Main navigation">
      <div
        role="tablist"
        aria-label="Site sections"
        className="flex flex-wrap gap-1 bg-brand-800 p-1 rounded-lg"
      >
        {TABS.map((tab, index) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => setTabRef(el, index)}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`
                px-4 py-2 rounded-md text-sm font-medium transition-colors
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white
                ${
                  isActive
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-brand-200 hover:text-white hover:bg-brand-700'
                }
              `}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
