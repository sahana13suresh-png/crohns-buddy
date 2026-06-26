'use client';

import React from 'react';

interface TeamMember {
  name: string;
  role: string;
}

const teamMembers: TeamMember[] = [
  { name: 'Sahana Suresh', role: 'Founder and Crohn\'s Patient' },
  { name: 'Annabelle Koo', role: 'Marketing and Outreach' },
];

export default function WelcomePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-12">
      {/* Introductory Section */}
      <section aria-labelledby="welcome-heading">
        <h1 id="welcome-heading" className="mb-4">Welcome to Crohn&#39;s Buddy</h1>
        <p className="text-lg text-gray-700 leading-relaxed">
          Crohn&#39;s Buddy is a supportive platform built for teens and young adults living with
          Crohn&#39;s Disease. Our mission is to empower patients with educational resources,
          symptom tracking tools, AI-powered meal planning, and a welcoming community — all in
          one place.
        </p>
        <p className="mt-4 text-gray-600 leading-relaxed">
          Whether you&#39;re newly diagnosed or have been managing Crohn&#39;s for years, we&#39;re here to
          help you understand your condition, track your health patterns, discover foods that work
          for your body, and connect with others who get it.
        </p>
      </section>

      {/* Meet the Team Section */}
      <section aria-labelledby="team-heading">
        <h2 id="team-heading" className="mb-6">Meet the Team</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {teamMembers.map((member) => (
            <div key={member.name} className="card text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-100 flex items-center justify-center">
                <span className="text-2xl text-brand-600 font-bold" aria-hidden="true">
                  {member.name.charAt(0)}
                </span>
              </div>
              <h3 className="text-lg">{member.name}</h3>
              <p className="text-gray-600 mt-1">{member.role}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
