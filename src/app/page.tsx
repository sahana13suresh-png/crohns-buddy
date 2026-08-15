'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import TabNavigation, { TabId } from '@/components/TabNavigation';
import AuthModal from '@/components/AuthModal';
import WelcomePage from '@/components/pages/WelcomePage';
import AboutPage from '@/components/pages/AboutPage';
import SymptomTrackerPage from '@/components/pages/SymptomTrackerPage';
import MealPlannerPage from '@/components/pages/MealPlannerPage';
import ResourcesPage from '@/components/pages/ResourcesPage';
import ContactPage from '@/components/pages/ContactPage';
import { onAuthChange, signOut, User } from '@/lib/auth';

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('welcome');
  const [user, setUser] = useState<User | null>(null);
  const [authModal, setAuthModal] = useState<'login' | 'signup' | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthChange((u) => setUser(u));
    return unsubscribe;
  }, []);

  const handleSignOut = async () => {
    await signOut();
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'welcome':
        return <WelcomePage onNavigate={setActiveTab} />;
      case 'about':
        return <AboutPage />;
      case 'tracker':
        return <SymptomTrackerPage />;
      case 'planner':
        return <MealPlannerPage />;
      case 'resources':
        return <ResourcesPage />;
      case 'contact':
        return <ContactPage />;
      default:
        return <WelcomePage onNavigate={setActiveTab} />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-brand-50">
      {/* Header */}
      <header className="border-b border-brand-800/10">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
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

          {/* Auth buttons */}
          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-4">
                <span className="text-xs uppercase tracking-widest text-brand-800/60 hidden sm:inline">
                  {user.displayName || user.email}
                </span>
                <button
                  onClick={handleSignOut}
                  className="text-xs uppercase tracking-widest text-brand-800/60 hover:text-brand-800 transition-opacity duration-200"
                >
                  Log Out
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setAuthModal('login')}
                  className="text-xs uppercase tracking-widest text-brand-800/60 hover:text-brand-800 transition-opacity duration-200"
                >
                  Log In
                </button>
                <button
                  onClick={() => setAuthModal('signup')}
                  className="text-xs uppercase tracking-widest text-brand-50 bg-brand-800 px-4 py-2 rounded-sm hover:opacity-80 transition-opacity duration-200"
                >
                  Sign Up
                </button>
              </>
            )}
          </div>
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

      {/* Auth Modal */}
      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => setAuthModal(null)}
          onSuccess={() => setAuthModal(null)}
          onSwitchMode={() => setAuthModal(authModal === 'login' ? 'signup' : 'login')}
        />
      )}
    </div>
  );
}
