import type { Metadata } from 'next';
import './globals.css';

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
