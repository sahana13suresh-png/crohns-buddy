import type { Metadata } from 'next';
import { Anton, Inter } from 'next/font/google';
import AccountMenu from '@/components/auth/AccountMenu';
import EmailVerificationBanner from '@/components/auth/EmailVerificationBanner';
import SessionProvider from '@/components/auth/SessionProvider';
import './globals.css';

const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: "Crohn's Buddy - Your Companion for Living with Crohn's Disease",
  description:
    "An advocacy and helper website for Crohn's Disease patients, providing educational resources, symptom tracking, AI meal planning, and community support.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${anton.variable} ${inter.variable}`}>
      <body>
        {/* Session state for every page (Requirements 2.4, 2.5, 2.13). */}
        <SessionProvider>
          <div className="min-h-screen flex flex-col">
            {/* The account controls belong to the layout, not to a page, because
                Requirement 2.4 asks for them in the header of every page. */}
            <AccountMenu />
            {/* Requirement 1.7 — shown on every page while the signed-in
                Account's email address awaits verification, and nothing at all
                otherwise. */}
            <EmailVerificationBanner />
            <div className="flex-1 flex flex-col">{children}</div>
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
