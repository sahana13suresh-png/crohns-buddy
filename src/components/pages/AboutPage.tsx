'use client';

import React from 'react';

/**
 * AboutPage - Educational content about Crohn's Disease and IBD.
 *
 * Sections:
 * 1. What is Crohn's Disease
 * 2. What is IBD
 * 3. Common Symptoms
 * 4. Causes and Risk Factors
 * 5. Treatment Approaches
 *
 * All content is static informational text with no user interaction required.
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */
export default function AboutPage() {
  return (
    <div className="page-shell max-w-5xl space-y-10">
      <div className="page-intro">
        <p className="eyebrow mb-4">Understanding Crohn&#39;s</p>
        <h1 className="mb-4">About Crohn&#39;s Disease</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-brand-800/60">
          Straightforward information to help you understand the condition, common symptoms,
          and the care options you may discuss with your healthcare team.
        </p>
      </div>

      {/* Section 1: What is Crohn's Disease */}
      <section aria-labelledby="what-is-crohns">
        <h2 id="what-is-crohns" className="mb-4">
          What is Crohn&#39;s Disease?
        </h2>
        <div className="card space-y-3 leading-relaxed text-brand-800/70">
          <p>
            Crohn&#39;s Disease is a chronic inflammatory condition that affects
            the digestive tract. It belongs to a group of conditions known as
            Inflammatory Bowel Disease (IBD). Unlike some other digestive
            conditions, Crohn&#39;s can affect any part of the gastrointestinal
            tract from the mouth to the anus, though it most commonly affects
            the end of the small intestine (ileum) and the beginning of the
            colon.
          </p>
          <p>
            The inflammation caused by Crohn&#39;s Disease can penetrate deep
            into the layers of affected bowel tissue, leading to pain and other
            symptoms that can sometimes be debilitating. It is a lifelong
            condition with periods of flare-ups and remission.
          </p>
        </div>
      </section>

      {/* Section 2: What is IBD */}
      <section aria-labelledby="what-is-ibd">
        <h2 id="what-is-ibd" className="mb-4">
          What is Inflammatory Bowel Disease (IBD)?
        </h2>
        <div className="card space-y-3 leading-relaxed text-brand-800/70">
          <p>
            Inflammatory Bowel Disease (IBD) is an umbrella term used to
            describe disorders that involve chronic inflammation of the
            digestive tract. The two main types of IBD are:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>
              <span className="font-semibold text-brand-700">
                Crohn&#39;s Disease
              </span>{' '}
              — Can affect any part of the GI tract and often involves
              inflammation that extends through the full thickness of the bowel
              wall.
            </li>
            <li>
              <span className="font-semibold text-brand-700">
                Ulcerative Colitis
              </span>{' '}
              — Affects only the colon (large intestine) and rectum, with
              inflammation limited to the innermost lining of the colon.
            </li>
          </ul>
          <p>
            While both conditions share some symptoms, they differ in location,
            depth of inflammation, and treatment approaches. IBD is different
            from Irritable Bowel Syndrome (IBS), which does not cause
            inflammation or damage to the bowel.
          </p>
        </div>
      </section>

      {/* Section 3: Common Symptoms */}
      <section aria-labelledby="common-symptoms">
        <h2 id="common-symptoms" className="mb-4">
          Common Symptoms
        </h2>
        <div className="card space-y-3 leading-relaxed text-brand-800/70">
          <p>
            Symptoms of Crohn&#39;s Disease can range from mild to severe and
            may develop gradually or come on suddenly. Common symptoms include:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>Abdominal pain and cramping</li>
            <li>Persistent diarrhea</li>
            <li>Fatigue and low energy</li>
            <li>Unintended weight loss</li>
            <li>Reduced appetite</li>
            <li>Blood in stool</li>
            <li>Fever</li>
            <li>Mouth sores</li>
            <li>Nausea</li>
            <li>Joint pain or skin issues</li>
          </ul>
          <p>
            Symptoms may vary from person to person and can change over time.
            Many people with Crohn&#39;s experience periods of remission where
            symptoms are minimal or absent, followed by flare-ups when symptoms
            become more active.
          </p>
        </div>
      </section>

      {/* Section 4: Causes and Risk Factors */}
      <section aria-labelledby="causes-risk-factors">
        <h2 id="causes-risk-factors" className="mb-4">
          Causes and Risk Factors
        </h2>
        <div className="card space-y-3 leading-relaxed text-brand-800/70">
          <p>
            The exact cause of Crohn&#39;s Disease is not fully understood, but
            research suggests a combination of factors may contribute to its
            development:
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Immune System
          </h3>
          <p>
            In Crohn&#39;s Disease, the immune system may mistakenly attack
            healthy cells in the digestive tract. This abnormal immune response
            causes chronic inflammation. It may be triggered by bacteria or
            viruses, though no specific pathogen has been identified as the
            cause.
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Genetics
          </h3>
          <p>
            Crohn&#39;s Disease is more common in people who have family members
            with the condition. Researchers have identified genes that may
            increase susceptibility, though having these genes does not guarantee
            development of the disease.
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Environmental Factors
          </h3>
          <p>
            Several environmental factors may increase the risk of developing
            Crohn&#39;s Disease:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>Smoking (the most significant controllable risk factor)</li>
            <li>Diet high in processed foods</li>
            <li>Living in an urban or industrialized area</li>
            <li>Use of certain medications (such as NSAIDs or antibiotics)</li>
            <li>Age — most often diagnosed between ages 15 and 35</li>
          </ul>
        </div>
      </section>

      {/* Section 5: Treatment Approaches */}
      <section aria-labelledby="treatment-approaches">
        <h2 id="treatment-approaches" className="mb-4">
          Treatment Approaches
        </h2>
        <div className="card space-y-3 leading-relaxed text-brand-800/70">
          <p>
            While there is currently no cure for Crohn&#39;s Disease, several
            treatment approaches can help manage symptoms, reduce inflammation,
            and improve quality of life:
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Medication
          </h3>
          <p>
            Various medications are used depending on the severity of the
            condition, including anti-inflammatory drugs, immune system
            suppressors, biologics, antibiotics, and medications to manage
            specific symptoms like diarrhea or pain.
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Nutrition Therapy
          </h3>
          <p>
            Dietary changes and nutritional supplements can play an important
            role in managing Crohn&#39;s. Some patients benefit from specific
            diets that reduce inflammation or avoid trigger foods. A registered
            dietitian can help create a personalized nutrition plan.
          </p>
          <h3 className="text-lg font-semibold text-brand-700 mt-4">
            Surgery
          </h3>
          <p>
            When medications and lifestyle changes are not enough, surgery may
            be recommended. Up to 70% of people with Crohn&#39;s Disease may
            eventually need some type of surgery. Common procedures include
            removing damaged sections of the digestive tract or draining
            abscesses.
          </p>
          <p className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
            <span className="font-semibold">Important:</span> Always consult
            with your healthcare provider about the best treatment plan for your
            specific situation. Treatment plans are individualized based on the
            severity, location, and behavior of the disease.
          </p>
        </div>
      </section>
    </div>
  );
}
