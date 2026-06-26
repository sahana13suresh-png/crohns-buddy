'use client';

import { useState } from 'react';
import Image from 'next/image';
import TabNavigation, { TabId } from '@/components/TabNavigation';
import WelcomePage from '@/components/pages/WelcomePage';
import AboutPage from '@/components/pages/AboutPage';
import SymptomTrackerPage from '@/components/pages/SymptomTrackerPage';
import MealPlannerPage from '@/components/pages/MealPlannerPage';
import ResourcesPage from '@/components/pages/ResourcesPage';

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('welcome');

  const renderTabContent = () => {
    switch (activeTab) {
      case 'welcome':
        return <WelcomePage />;
      case 'about':
        return <AboutPage />;
      case 'tracker':
        return <SymptomTrackerPage />;
      case 'planner':
        return <MealPlannerPage />;
      case 'resources':
        return <ResourcesPage />;
      default:
        return <WelcomePage />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-brand-800 text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <Image
            src="/logo.svg"
            alt="Crohn's Buddy logo — light blue background with Crohn's Buddy text in blue, heart and sparkle decorations"
            width={48}
            height={48}
            className="rounded-lg"
            priority
          />
          <h1 className="text-xl font-bold text-white">Crohn&#39;s Buddy</h1>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 bg-gray-50">
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
