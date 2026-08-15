'use client';

import React from 'react';
import Image from 'next/image';
import { TabId } from '@/components/TabNavigation';

interface WelcomePageProps {
  onNavigate: (tabId: TabId) => void;
}

export default function WelcomePage({ onNavigate }: WelcomePageProps) {
  return (
    <div className="max-w-7xl mx-auto px-6 md:px-12">
      {/* Hero — left-aligned with illustration on right */}
      <section className="py-24 md:py-32 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        <div className="max-w-xl">
          <p className="text-xs uppercase tracking-widest text-brand-400 mb-6">
            Built by patients, for patients
          </p>
          <h1 className="text-brand-800 mb-8 leading-[1.1]">
            Your companion for<br />living with Crohn&#39;s.
          </h1>
          <p className="text-brand-800/60 text-lg md:text-xl leading-relaxed">
            A platform to track symptoms, discover meals that work for your body,
            and connect with people who understand.
          </p>
        </div>
        <div className="flex justify-center md:justify-end">
          <Image
            src="/logo.png"
            alt="Illustrated colon with scalloped edges"
            width={440}
            height={440}
          />
        </div>
      </section>

      <div className="divider" />

      {/* Features — typographic columns with links */}
      <section className="py-24 md:py-32">
        <p className="text-xs uppercase tracking-widest text-brand-400 mb-12">
          What you&#39;ll find here
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-12">
          <div>
            <button onClick={() => onNavigate('about')} className="text-left group">
              <h3 className="mb-3 group-hover:text-brand-400 transition-colors duration-200">Learn About Crohn&#39;s</h3>
            </button>
            <p className="text-brand-800/50 leading-relaxed">
              Clear, approachable explanations of your condition and how to manage it day to day.
            </p>
          </div>
          <div>
            <button onClick={() => onNavigate('tracker')} className="text-left group">
              <h3 className="mb-3 group-hover:text-brand-400 transition-colors duration-200">Track Symptoms</h3>
            </button>
            <p className="text-brand-800/50 leading-relaxed">
              Log how you&#39;re feeling daily. Spot patterns over time and share insights with your doctor.
            </p>
          </div>
          <div>
            <button onClick={() => onNavigate('planner')} className="text-left group">
              <h3 className="mb-3 group-hover:text-brand-400 transition-colors duration-200">AI Meal Planner</h3>
            </button>
            <p className="text-brand-800/50 leading-relaxed">
              Personalized meal ideas based on your tolerances, preferences, and current symptoms.
            </p>
          </div>
          <div>
            <button onClick={() => onNavigate('resources')} className="text-left group">
              <h3 className="mb-3 group-hover:text-brand-400 transition-colors duration-200">Resources & Support</h3>
            </button>
            <p className="text-brand-800/50 leading-relaxed">
              Curated links, community connections, and support for teens and young adults with IBD.
            </p>
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* Community photo */}
      <section className="py-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-4">
              You&#39;re not alone
            </p>
            <h2 className="mb-6">Built with care,<br />for people like us.</h2>
            <p className="text-brand-800/50 leading-relaxed">
              Living with Crohn&#39;s means navigating uncertainty every day. We built this
              space so you can feel a little more in control, a little more supported,
              and a little less alone in your journey.
            </p>
          </div>
          <div className="overflow-hidden rounded-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://images.unsplash.com/photo-1543269865-cbf427effbad?w=600&h=400&fit=crop&crop=faces"
              alt="Group of young friends smiling together"
              className="w-full h-64 md:h-80 object-cover"
              loading="lazy"
            />
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* Meet the Team */}
      <section className="py-24 md:py-32">
        <p className="text-xs uppercase tracking-widest text-brand-400 mb-12">
          Meet the team
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-16">
          {/* Sahana */}
          <div>
            <h3 className="mb-1">Sahana Suresh</h3>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-6">
              Founder & Crohn&#39;s Patient
            </p>
            <div className="space-y-4 text-brand-800/60 leading-relaxed">
              <p>
                I was diagnosed with Crohn&#39;s disease 4 years ago. I know firsthand
                how overwhelming it can be, figuring out what to eat, managing unpredictable
                symptoms, and feeling like no one quite understands what you&#39;re going through.
              </p>
              <p>
                That&#39;s exactly why I created Crohn&#39;s Buddy. I wanted to build a platform
                that makes life a little easier for fellow patients. A friendly, all-in-one place
                where you can track your symptoms, discover meals that work for your body, and
                connect with people who truly get it.
              </p>
              <p>
                Whether you&#39;re newly diagnosed or have been on this journey for a while,
                you&#39;re not alone. I&#39;m glad you&#39;re here.
              </p>
            </div>
          </div>

          {/* Annabelle */}
          <div>
            <h3 className="mb-1">Annabelle Koo</h3>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-6">
              Marketing & Outreach
            </p>
            <div className="space-y-4 text-brand-800/60 leading-relaxed">
              <p>
                I understand that living with Crohn&#39;s disease can sometimes feel exhausting
                and isolating. We created Crohn&#39;s Buddy with the hope of making that journey
                feel a little less overwhelming.
              </p>
              <p>
                Everyone deserves a space where they feel supported and cared for, and our goal
                is to help others feel more comfortable while providing resources and a community
                that reminds them they&#39;re never alone.
              </p>
            </div>
          </div>
        </div>

        {/* Shared team message */}
        <div className="mt-16 text-center max-w-2xl mx-auto">
          <blockquote className="text-brand-800/70 text-lg md:text-xl italic leading-relaxed border-l-4 border-brand-300 pl-6 py-2">
            &ldquo;Whether you&#39;re newly diagnosed or have been on this journey for a while,
            you&#39;re not alone. We&#39;re glad you&#39;re here.&rdquo;
          </blockquote>
          <p className="text-sm text-brand-400 mt-4">— Sahana & Annabelle</p>
        </div>
      </section>
    </div>
  );
}
