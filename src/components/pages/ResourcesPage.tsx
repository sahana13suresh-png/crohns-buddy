'use client';

import React from 'react';
import ChatForum from '@/components/forum/ChatForum';

interface ExternalLink {
  title: string;
  url: string;
  description: string;
  category: 'teen' | 'general' | 'organization';
}

const externalLinks: ExternalLink[] = [
  {
    title: 'Camp Oasis',
    url: 'https://www.crohnscolitisfoundation.org/get-involved/camp-oasis',
    description:
      'A summer camp program for kids and teens with IBD — a chance to have fun, make friends, and feel understood.',
    category: 'teen',
  },
  {
    title: 'Crohn\'s & Colitis Foundation',
    url: 'https://www.crohnscolitisfoundation.org/',
    description:
      'Leading nonprofit organization dedicated to finding cures for Crohn\'s Disease and ulcerative colitis.',
    category: 'organization',
  },
  {
    title: 'IBD School for Teens',
    url: 'https://www.crohnscolitisfoundation.org/youth-parent-resources',
    description:
      'Youth and parent resources from the Crohn\'s & Colitis Foundation, including guides tailored for teens navigating life with IBD.',
    category: 'teen',
  },
  {
    title: 'ImproveCareNow',
    url: 'https://www.improvecarenow.org/',
    description:
      'A collaborative network of patients, families, and clinicians working together to improve care for children and teens with IBD.',
    category: 'teen',
  },
  {
    title: 'Crohn\'s & Colitis UK — Young People',
    url: 'https://crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/living-with-crohns-or-colitis/young-people',
    description:
      'Information and support specifically for young people living with Crohn\'s Disease and colitis.',
    category: 'teen',
  },
  {
    title: 'Mayo Clinic — Crohn\'s Disease',
    url: 'https://www.mayoclinic.org/diseases-conditions/crohns-disease/symptoms-causes/syc-20353304',
    description:
      'Comprehensive medical information on symptoms, causes, and treatment options for Crohn\'s Disease.',
    category: 'general',
  },
  {
    title: 'CCFA Power of Two Mentoring',
    url: 'https://www.crohnscolitisfoundation.org/get-involved/power-of-two-mentoring-program',
    description:
      'A peer mentoring program connecting IBD patients with trained mentors who understand the journey.',
    category: 'organization',
  },
  {
    title: 'GI Kids — NASPGHAN',
    url: 'https://gikids.org/',
    description:
      'Trusted resource from pediatric gastroenterologists providing kid- and teen-friendly digestive health information.',
    category: 'general',
  },
];

const categoryLabels: Record<ExternalLink['category'], string> = {
  teen: 'Teen & Youth',
  general: 'General Information',
  organization: 'Organizations',
};

const categoryColors: Record<ExternalLink['category'], string> = {
  teen: 'bg-brand-100 text-brand-700',
  general: 'bg-blue-50 text-blue-700',
  organization: 'bg-indigo-50 text-indigo-700',
};

export default function ResourcesPage() {
  return (
    <div className="page-shell max-w-5xl space-y-16">
      {/* External Links Section */}
      <section aria-labelledby="resources-heading">
        <p className="eyebrow mb-4">Trusted places to turn</p>
        <h1 id="resources-heading" className="mb-4">Resources</h1>
        <p className="mb-10 max-w-2xl text-lg leading-relaxed text-brand-800/60">
          Curated links to helpful organizations, educational materials, and teen-specific
          support for Crohn&#39;s Disease and IBD patients.
        </p>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {externalLinks.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="card surface-card-hover group no-underline"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-base font-semibold text-brand-800 group-hover:text-brand-600">
                      {link.title}
                    </h3>
                    <svg
                      className="w-4 h-4 text-brand-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </div>
                  <p className="mb-4 text-sm leading-relaxed text-brand-800/60">{link.description}</p>
                  <span
                    className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${categoryColors[link.category]}`}
                  >
                    {categoryLabels[link.category]}
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Community Forum Section */}
      <section aria-labelledby="forum-heading" className="surface-card">
        <p className="eyebrow mb-4">Connect with others</p>
        <h2 id="forum-heading" className="mb-4">Community Forum</h2>
        <p className="mb-8 max-w-2xl text-brand-800/60">
          Connect with other Crohn&#39;s patients, share experiences, and support each other in
          our community chat.
        </p>

        <ChatForum />
      </section>
    </div>
  );
}
