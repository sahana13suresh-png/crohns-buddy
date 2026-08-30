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
      {/* Header */}
      <header className="border-b border-brand-800/10">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-6 flex items-center gap-3">
          <Image
            src="/logo.png"
            alt="Crohn's Buddy logo"
            width={56}
            height={56}
            priority
          />
          <h1 className="text-2xl md:text-3xl font-heading text-brand-800 uppercase tracking-widest">
            Crohn&#39;s Buddy
          </h1>
        </div>

        {/* Navigation */}
        <div className="max-w-7xl mx-auto px-6 md:px-12 pb-0">
          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">
        <div
          role="tabpanel"
          id={`tabpanel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
        >
          {renderTabContent()}
        </div>
      </main>
    </div>
  );
}
