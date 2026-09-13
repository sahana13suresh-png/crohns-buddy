import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * PrivacyNotice — the static Privacy_Notice page at `/privacy`.
 *
 * - **Requirement 12.1** — names the health-related data a saved meal plan is
 *   derived from (symptom, medication, allergy, and flare-status quiz answers),
 *   explains how records are protected, states that records are kept until the
 *   Patient deletes them or completes account deletion, and states how the
 *   export control and the deletion control are reached.
 * - **Requirement 12.2** — readable with no Session. This is a server
 *   component with no session hook, no `useSession()`, and no client bundle,
 *   so it renders identically for a signed-out visitor and a signed-in one.
 *   `AuthModal` and `AccountSettingsPage` link here.
 * - **Requirement 12.10** — states that the Website gives no medical advice
 *   and that a clinician should be consulted before a diet change.
 *
 * The copy describes privacy behavior in terms useful to a Patient without
 * exposing implementation vendors, products, regions, or service topology.
 */

export const metadata: Metadata = {
  title: "Privacy Notice - Crohn's Buddy",
  description:
    "What information Crohn's Buddy saves, how it is protected, how long it is kept, and how to remove or download it.",
};

const SECTION_HEADING = 'mb-4';
const CARD = 'surface-card space-y-3 leading-relaxed text-brand-800/70';

export default function PrivacyNotice() {
  return (
    <div className="page-shell max-w-4xl space-y-10">
      <div className="page-intro">
        <p className="eyebrow mb-4">Clear and transparent</p>
        <h1 className="mb-4">Privacy Notice</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-brand-800/60">
          What Crohn&#39;s Buddy saves, how it is protected, and the choices you have.
        </p>
      </div>

      <section aria-labelledby="what-we-store">
        <h2 id="what-we-store" className={SECTION_HEADING}>
          What we store
        </h2>
        <div className={CARD}>
          <p>
            When you save a meal plan, we add it to your account. Saved meal
            plans are derived from health-related quiz answers you give the AI
            Meal Planner, covering your{' '}
            <span className="font-semibold text-brand-700">symptoms</span>, your{' '}
            <span className="font-semibold text-brand-700">medications</span>,
            your{' '}
            <span className="font-semibold text-brand-700">allergies</span>, and
            your{' '}
            <span className="font-semibold text-brand-700">flare status</span>.
            That is health-related data, so it is worth deciding deliberately
            whether you want it saved.
          </p>
          <p>
            Alongside a saved meal plan we store the plan title you choose, the
            dates the plan was created and last updated, and the account
            identity we get from signing you in: your user id, your display
            name, and your email address.
          </p>
          <p>
            Generating a meal plan does not require an account and does not
            save it to an account. The first time you save a plan, we show a
            notice explaining what will be saved and ask you to acknowledge it
            before the plan is added to your account.
          </p>
          <p>
            Symptom Tracker entries are a separate case: they stay in your
            browser on the device where you entered them and are not included
            with your online account.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-we-protect-it">
        <h2 id="how-we-protect-it" className={SECTION_HEADING}>
          How we protect it
        </h2>
        <div className={CARD}>
          <p>
            Saved meal plans are encrypted while stored and while being sent
            between your browser and Crohn&apos;s Buddy. Access to saved plans
            requires signing in to the account that owns them.
          </p>
          <p>
            We do not send meal plan content, quiz answers, email addresses, or
            display names to analytics or error-reporting services.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-long-we-keep-it">
        <h2 id="how-long-we-keep-it" className={SECTION_HEADING}>
          How long we keep it
        </h2>
        <div className={CARD}>
          <p>
            Saved meal plans are retained until you delete them or until you
            complete account deletion. There is no automatic expiry, and we do
            not remove your saved meal plans on our own schedule.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-to-remove-it">
        <h2 id="how-to-remove-it" className={SECTION_HEADING}>
          How to remove it, and how to get a copy
        </h2>
        <div className={CARD}>
          <p>
            You can remove one saved plan at a time, or remove everything at
            once:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>
              <span className="font-semibold text-brand-700">
                Delete a single saved plan
              </span>{' '}
              — open the AI Meal Planner while signed in, find the plan in your
              saved plans list, and activate the delete control on that plan.
              You confirm the plan by title, and it is removed from your
              account.
            </li>
            <li>
              <span className="font-semibold text-brand-700">
                Delete your account and all of its data
              </span>{' '}
              — open account settings from the account menu in the page header
              while signed in, and activate the delete account control. The
              deletion flow lists what will be removed, asks you to type DELETE
              to confirm, and then removes every saved meal plan owned by your
              account, your account itself, and the Symptom Tracker entries held
              in this browser. It cannot be undone.
            </li>
            <li>
              <span className="font-semibold text-brand-700">
                Download a copy of your data
              </span>{' '}
              — the export control sits in the same account settings view,
              reached from the account menu in the page header while signed in,
              and it is also offered inside the deletion flow so you can take a
              copy before anything is removed. It downloads a file containing
              your account details, your saved meal plans, and the Symptom
              Tracker entries held in this browser.
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="not-medical-advice">
        <h2 id="not-medical-advice" className={SECTION_HEADING}>
          Not medical advice
        </h2>
        <div className={CARD}>
          <p className="rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
            <span className="font-semibold">Important:</span> Crohn&#39;s Buddy
            provides no medical advice. Nothing on this site, including
            AI-generated meal plans, is a diagnosis, a treatment plan, or a
            substitute for professional care. Please consult a clinician before
            changing your diet.
          </p>
        </div>
      </section>

      <p className="text-center text-sm">
        <Link href="/" className="btn-secondary">
          Back to Crohn&#39;s Buddy
        </Link>
      </p>
    </div>
  );
}
