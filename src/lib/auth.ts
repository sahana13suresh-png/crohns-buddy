/**
 * Firebase Authentication helpers for Crohn's Buddy.
 */

import {
  getAuth,
  Auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
  Unsubscribe,
  updateProfile,
} from 'firebase/auth';
import { getApps, getApp, initializeApp } from 'firebase/app';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getFirebaseApp() {
  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return app;
}

let auth: Auth;

export function getFirebaseAuth(): Auth {
  if (!auth) {
    if (!firebaseConfig.apiKey) {
      throw new Error('Firebase is not configured. Please add your Firebase credentials to .env.local');
    }
    auth = getAuth(getFirebaseApp());
  }
  return auth;
}

export async function signUp(email: string, password: string, displayName: string): Promise<User> {
  const userCredential = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
  await updateProfile(userCredential.user, { displayName });
  return userCredential.user;
}

export async function signIn(email: string, password: string): Promise<User> {
  const userCredential = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  return userCredential.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(getFirebaseAuth());
}

export function onAuthChange(callback: (user: User | null) => void): Unsubscribe {
  if (!firebaseConfig.apiKey) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

export type { User };
