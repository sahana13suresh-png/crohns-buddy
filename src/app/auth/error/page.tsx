import Link from 'next/link';

const MESSAGE: Record<string, string> = {
  provider: 'The identity provider did not complete sign-in.',
  state: 'The sign-in request expired or could not be verified.',
  code: 'The identity provider returned an incomplete response.',
  invalid: 'The sign-in response could not be verified.',
  unavailable: 'Account sign-in is temporarily unavailable.',
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason = 'unavailable' } = await searchParams;
  const message = MESSAGE[reason] ?? MESSAGE.unavailable;

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-20">
      <section className="max-w-lg bg-white border border-brand-800/10 rounded-sm p-8 space-y-5">
        <p className="text-xs uppercase tracking-widest text-brand-400">Secure account</p>
        <h1 className="text-3xl">We couldn&apos;t sign you in</h1>
        <p className="text-brand-800/70">{message} No password or account data was stored.</p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/api/auth/start?intent=signup&prompt=login"
            className="btn-primary inline-flex"
          >
            Try sign up again
          </Link>
          <Link
            href="/"
            className="inline-flex items-center px-4 py-3 text-brand-800/70"
          >
            Return home
          </Link>
        </div>
      </section>
    </main>
  );
}
