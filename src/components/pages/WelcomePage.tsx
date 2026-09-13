'use client';

import React from 'react';
import Image from 'next/image';
import { TabId } from '@/components/TabNavigation';

interface WelcomePageProps {
  onNavigate: (tabId: TabId) => void;
}

export default function WelcomePage({ onNavigate }: WelcomePageProps) {
  return (
    <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
      <section className="grid grid-cols-1 items-center gap-12 py-16 md:py-24 lg:grid-cols-[1.08fr_0.92fr] lg:py-28">
        <div className="max-w-2xl">
          <p className="eyebrow mb-6">
            Built by patients, for patients
          </p>
          <h1 className="display-heading mb-7 max-w-2xl text-5xl leading-[0.98] sm:text-6xl lg:text-7xl">
            Your companion for<br />living with Crohn&#39;s.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-brand-800/65 md:text-xl">
            A platform to track symptoms, discover meals that work for your body,
            and connect with people who understand.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <button className="btn-primary" onClick={() => onNavigate('tracker')}>
              Track today&#39;s symptoms
            </button>
            <button className="btn-secondary" onClick={() => onNavigate('planner')}>
              Build a meal plan
            </button>
          </div>
          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm font-medium text-brand-800/55">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Private symptom tracking
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brand-500" />
              Personalized support
            </span>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-lg lg:ml-auto">
          <div className="absolute -left-6 top-8 h-24 w-24 rounded-full bg-emerald-200/40 blur-2xl" />
          <div className="absolute -right-8 bottom-4 h-32 w-32 rounded-full bg-brand-300/50 blur-3xl" />
          <div className="relative px-4 pb-6 pt-10 sm:px-8">
            <div className="absolute right-5 top-2 rounded-full border border-brand-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-brand-700 shadow-sm backdrop-blur sm:right-8">
              Here for the everyday
            </div>
            <Image
              src="/logo.png"
              alt="Illustrated colon with scalloped edges"
              width={440}
              height={440}
              className="mx-auto drop-shadow-[0_18px_25px_rgba(15,34,64,0.12)]"
            />
            <div className="relative mx-auto -mt-7 grid max-w-md grid-cols-2 gap-3">
              <div className="rounded-2xl border border-brand-100 bg-white/90 p-4 shadow-sm backdrop-blur">
                <p className="text-2xl font-bold text-brand-800">4</p>
                <p className="mt-1 text-xs font-medium text-brand-800/55">practical tools in one place</p>
              </div>
              <div className="rounded-2xl border border-brand-100 bg-white/90 p-4 shadow-sm backdrop-blur">
                <p className="text-2xl font-bold text-brand-800">1</p>
                <p className="mt-1 text-xs font-medium text-brand-800/55">supportive community</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <p className="eyebrow mb-4">
          What you&#39;ll find here
        </p>
        <div className="mb-10 flex max-w-3xl flex-col gap-3">
          <h2 className="text-3xl md:text-4xl">Useful tools, without the clinical overwhelm.</h2>
          <p className="text-brand-800/60">
            Learn, track, plan, and find support through an experience designed to feel clear and approachable.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="surface-card surface-card-hover group">
            <span className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-sm font-bold text-brand-700">01</span>
            <button onClick={() => onNavigate('about')} className="text-left">
              <h3 className="mb-3 transition-colors duration-200 group-hover:text-brand-600">Learn About Crohn&#39;s</h3>
            </button>
            <p className="leading-relaxed text-brand-800/55">
              Clear, approachable explanations of your condition and how to manage it day to day.
            </p>
            <button onClick={() => onNavigate('about')} className="mt-6 text-sm font-semibold text-brand-700">
              Learn more <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="surface-card surface-card-hover group">
            <span className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-sm font-bold text-emerald-700">02</span>
            <button onClick={() => onNavigate('tracker')} className="text-left">
              <h3 className="mb-3 transition-colors duration-200 group-hover:text-brand-600">Track Symptoms</h3>
            </button>
            <p className="leading-relaxed text-brand-800/55">
              Log how you&#39;re feeling daily. Spot patterns over time and share insights with your doctor.
            </p>
            <button onClick={() => onNavigate('tracker')} className="mt-6 text-sm font-semibold text-brand-700">
              Start tracking <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="surface-card surface-card-hover group">
            <span className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-sm font-bold text-amber-700">03</span>
            <button onClick={() => onNavigate('planner')} className="text-left">
              <h3 className="mb-3 transition-colors duration-200 group-hover:text-brand-600">AI Meal Planner</h3>
            </button>
            <p className="leading-relaxed text-brand-800/55">
              Personalized meal ideas based on your tolerances, preferences, and current symptoms.
            </p>
            <button onClick={() => onNavigate('planner')} className="mt-6 text-sm font-semibold text-brand-700">
              Create a plan <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="surface-card surface-card-hover group">
            <span className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-violet-100 text-sm font-bold text-violet-700">04</span>
            <button onClick={() => onNavigate('resources')} className="text-left">
              <h3 className="mb-3 transition-colors duration-200 group-hover:text-brand-600">Resources & Support</h3>
            </button>
            <p className="leading-relaxed text-brand-800/55">
              Curated links, community connections, and support for teens and young adults with IBD.
            </p>
            <button onClick={() => onNavigate('resources')} className="mt-6 text-sm font-semibold text-brand-700">
              Find support <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="grid grid-cols-1 items-center gap-10 overflow-hidden rounded-[2rem] bg-brand-800 p-6 text-white shadow-[0_30px_80px_-45px_rgba(15,34,64,0.65)] sm:p-10 md:grid-cols-2 lg:p-14">
          <div className="max-w-xl">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">
              You&#39;re not alone
            </p>
            <h2 className="mb-6 text-white">Built with care,<br />for people like us.</h2>
            <p className="leading-relaxed text-white/70">
              Living with Crohn&#39;s means navigating uncertainty every day. We built this
              space so you can feel a little more in control, a little more supported,
              and a little less alone in your journey.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://images.unsplash.com/photo-1543269865-cbf427effbad?w=600&h=400&fit=crop&crop=faces"
              alt="Group of young friends smiling together"
              className="h-64 w-full object-cover md:h-80"
              loading="lazy"
            />
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <p className="eyebrow mb-4">
          Meet the team
        </p>
        <h2 className="mb-10 max-w-2xl text-3xl md:text-4xl">People who understand the journey.</h2>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="surface-card p-7 sm:p-8">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700">
              SS
            </div>
            <h3 className="mb-1">Sahana Suresh</h3>
            <p className="mb-6 text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
              Founder & Crohn&#39;s Patient
            </p>
            <div className="space-y-4 leading-relaxed text-brand-800/60">
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

          <div className="surface-card p-7 sm:p-8">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700">
              AK
            </div>
            <h3 className="mb-1">Annabelle Koo</h3>
            <p className="mb-6 text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
              Marketing & Outreach
            </p>
            <div className="space-y-4 leading-relaxed text-brand-800/60">
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

        <div className="mx-auto mt-12 max-w-3xl text-center">
          <blockquote className="rounded-2xl border border-brand-200/70 bg-brand-50/70 px-6 py-7 text-lg italic leading-relaxed text-brand-800/70 md:text-xl">
            &ldquo;Whether you&#39;re newly diagnosed or have been on this journey for a while,
            you&#39;re not alone. We&#39;re glad you&#39;re here.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm font-semibold text-brand-600">— Sahana & Annabelle</p>
        </div>
      </section>
    </div>
  );
}
