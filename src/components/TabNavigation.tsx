'use client';

import { useRef, useCallback, KeyboardEvent } from 'react';

export type TabId =
  | 'welcome'
  | 'about'
  | 'tracker'
  | 'planner'
  | 'resources'
  | 'contact'
  | 'account';

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
  { id: 'contact', label: 'Contact Us' },
  { id: 'account', label: 'Account' },
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
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                relative rounded-full px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
                ${isActive
                  ? 'bg-brand-800 text-brand-800 !text-white shadow-sm after:absolute after:bottom-0 after:left-1/2 after:h-[2px] after:w-5 after:-translate-x-1/2 after:bg-brand-400 after:opacity-0'
                  : 'text-brand-800/40 hover:bg-brand-50 hover:text-brand-800/75'
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
