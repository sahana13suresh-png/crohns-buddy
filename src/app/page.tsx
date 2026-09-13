'use client';

import { useState } from 'react';
import Image from 'next/image';
import TabNavigation, { TabId } from '@/components/TabNavigation';
import WelcomePage from '@/components/pages/WelcomePage';
import AboutPage from '@/components/pages/AboutPage';
import SymptomTrackerPage from '@/components/pages/SymptomTrackerPage';
import MealPlannerPage from '@/components/pages/MealPlannerPage';
import AccountSettingsPage from '@/components/pages/AccountSettingsPage';
import ResourcesPage from '@/components/pages/ResourcesPage';
import ContactPage from '@/components/pages/ContactPage';
import SavedPlansList from '@/components/planner/SavedPlansList';

/**
 * The single-page shell. Session state and the account controls live in the
 * root layout (`AccountMenu` inside `SessionProvider`), so this component holds
 * no `onAuthChange` subscription of its own — one source of Session state, and
 * a header that is present on every page rather than only on this one.
 */
export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('welcome');

  const renderTabContent = () => {
    switch (activeTab) {
      case 'welcome':
        return <WelcomePage onNavigate={setActiveTab} />;
      case 'about':
        return <AboutPage />;
      case 'tracker':
        return <SymptomTrackerPage />;
      case 'planner':
        return (
          <MealPlannerPage
            renderSavedPlans={(openStoredPlan) => (
              <SavedPlansList onOpenPlan={openStoredPlan} />
            )}
          />
        );
      case 'resources':
        return <ResourcesPage />;
      case 'contact':
        return <ContactPage />;
      case 'account':
        return <AccountSettingsPage />;
      default:
        return <WelcomePage onNavigate={setActiveTab} />;
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <header className="sticky top-0 z-30 border-b border-brand-800/10 bg-white/85 shadow-[0_8px_30px_-24px_rgba(15,34,64,0.45)] backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 pt-3 lg:pt-4">
          <div className="flex items-center gap-3 pb-3 lg:pb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-200/70 bg-brand-50 shadow-sm">
              <Image
                src="/logo.png"
                alt="Crohn's Buddy logo"
                width={42}
                height={42}
                priority
              />
            </div>
            <div>
              <p className="display-heading text-xl leading-none sm:text-2xl">
                Crohn&#39;s Buddy
              </p>
              <p className="mt-1 hidden text-xs font-medium text-brand-800/50 sm:block">
                Everyday support for living well with Crohn&#39;s
              </p>
            </div>
          </div>

          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </header>

      <main className="flex-1">
        <div
          role="tabpanel"
          id={`tabpanel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
        >
          {renderTabContent()}
        </div>
      </main>

      <footer className="mt-auto border-t border-brand-800/10 bg-white/60">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-7 text-sm text-brand-800/55 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <p>Support, practical tools, and community for the Crohn&#39;s journey.</p>
          <p>&copy; {new Date().getFullYear()} Crohn&#39;s Buddy</p>
        </div>
      </footer>
    </div>
  );
}
