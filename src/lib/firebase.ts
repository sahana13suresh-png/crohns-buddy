/**
 * Firebase initialization and Firestore helpers for Crohn's Buddy.
 *
 * Uses environment variables prefixed with NEXT_PUBLIC_ for client-side access.
 * The Firestore collection "forum-messages" stores community chat messages.
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  Firestore,
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  Timestamp,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import {
  getAuth,
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { ForumMessage } from './types';

// ─── Firebase Configuration ────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// ─── Initialization ────────────────────────────────────────────────────────────

let app: FirebaseApp;
let db: Firestore;

function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  }
  return app;
}

export function getDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}

// ─── Authentication ────────────────────────────────────────────────────────────

let auth: Auth;

export function getAuthInstance(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }
  return auth;
}

/**
 * Sign in with Google popup.
 * Returns the authenticated user or null on failure.
 */
export async function signInWithGoogle(): Promise<User | null> {
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(getAuthInstance(), provider);
    return result.user;
  } catch (error) {
    console.error('Google sign-in failed:', error);
    return null;
  }
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(getAuthInstance());
}

/**
 * Subscribe to auth state changes.
 * Returns an unsubscribe function.
 */
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getAuthInstance(), callback);
}

// ─── Firestore Collection ──────────────────────────────────────────────────────

const FORUM_COLLECTION = 'forum-messages';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Posts a new message to the forum-messages collection.
 * The `removed` field defaults to false unless explicitly set.
 */
export async function postForumMessage(
  displayName: string,
  content: string,
  removed: boolean = false,
  removalNotice?: string
): Promise<string> {
  const messagesRef = collection(getDb(), FORUM_COLLECTION);
  const docRef = await addDoc(messagesRef, {
    displayName,
    content,
    removed,
    ...(removalNotice ? { removalNotice } : {}),
    timestamp: serverTimestamp(),
  });
  return docRef.id;
}

/**
 * Subscribes to real-time forum message updates.
 * Messages are ordered by timestamp descending (most recent first).
 * Returns an unsubscribe function.
 */
export function subscribeToForumMessages(
  callback: (messages: ForumMessage[]) => void
): Unsubscribe {
  const messagesRef = collection(getDb(), FORUM_COLLECTION);
  const q = query(messagesRef, orderBy('timestamp', 'desc'));

  return onSnapshot(q, (snapshot) => {
    const messages: ForumMessage[] = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        displayName: data.displayName ?? '',
        content: data.content ?? '',
        removed: data.removed ?? false,
        removalNotice: data.removalNotice,
        timestamp: data.timestamp instanceof Timestamp
          ? data.timestamp.toDate()
          : new Date(),
      };
    });
    callback(messages);
  });
}
