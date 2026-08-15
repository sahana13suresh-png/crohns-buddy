'use client';

import React from 'react';

export default function ContactPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 md:px-12">
      <section className="py-24 md:py-32 max-w-2xl">
        <p className="text-xs uppercase tracking-widest text-brand-400 mb-6">
          Get in touch
        </p>
        <h1 className="text-brand-800 mb-8 leading-[1.1]">
          Contact Us
        </h1>
        <p className="text-brand-800/60 text-lg leading-relaxed mb-12">
          Have questions, feedback, or just want to say hi? We&#39;d love to hear from you.
        </p>

        <div className="space-y-8">
          <div>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">Email</p>
            <a
              href="mailto:sahana13suresh@gmail.com"
              className="text-brand-800 text-lg hover:text-brand-400 no-underline transition-colors duration-200"
            >
              sahana13suresh@gmail.com
            </a>
          </div>

          <div className="divider" />

          <div>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">Phone</p>
            <a
              href="tel:+16304702906"
              className="text-brand-800 text-lg hover:text-brand-400 no-underline transition-colors duration-200"
            >
              (630) 470-2906
            </a>
          </div>

          <div className="divider" />

          <div>
            <p className="text-xs uppercase tracking-widest text-brand-400 mb-2">Response time</p>
            <p className="text-brand-800/60 leading-relaxed">
              We typically respond within 24 hours. Feel free to reach out anytime.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
