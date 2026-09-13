'use client';

import React from 'react';

export default function ContactPage() {
  return (
    <div className="page-shell max-w-5xl">
      <section className="grid items-start gap-10 md:grid-cols-[0.9fr_1.1fr]">
        <div>
        <p className="eyebrow mb-6">
          Get in touch
        </p>
        <h1 className="mb-6 leading-[1.1]">
          Contact Us
        </h1>
        <p className="text-lg leading-relaxed text-brand-800/60">
          Have questions, feedback, or just want to say hi? We&#39;d love to hear from you.
        </p>
        </div>

        <div className="surface-card space-y-8 p-7 sm:p-9">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-600">Email</p>
            <a
              href="mailto:sahana13suresh@gmail.com"
              className="break-all text-lg font-semibold text-brand-800 hover:text-brand-600"
            >
              sahana13suresh@gmail.com
            </a>
          </div>

          <div className="divider" />

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-600">Phone</p>
            <a
              href="tel:+16304702906"
              className="text-lg font-semibold text-brand-800 hover:text-brand-600"
            >
              (630) 470-2906
            </a>
          </div>

          <div className="divider" />

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-600">Response time</p>
            <p className="text-brand-800/60 leading-relaxed">
              We typically respond within 24 hours. Feel free to reach out anytime.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
