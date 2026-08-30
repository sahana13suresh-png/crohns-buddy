/**
 * Sole owner of the Firebase client configuration and the initialized FirebaseApp.
 *
 * `auth.ts` and `firebase.ts` both import from here so the config object and the
 * `initializeApp` guard exist in exactly one place. Every value comes from
 * platform-managed `NEXT_PUBLIC_FIREBASE_*` environment configuration; no
 * credential value is ever hard-coded here (Requirement 13.7).
 */

import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';

export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
} as const;

/**
 * True when the client Firebase credentials are present in the environment.
 * An empty string counts as absent, matching the server-side `assertServerEnv`
 * treatment of blank values.
 */
export function isFirebaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);
}

let app: FirebaseApp | undefined;

/**
 * Returns the single FirebaseApp instance, initializing it on first use.
 * Reuses an already-initialized default app so repeated module loads (and
 * Next.js fast refresh) never call `initializeApp` twice.
 */
export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  }
  return app;
}
