/**
 * Firestore helpers for Crohn's Buddy.
 *
 * The FirebaseApp and its configuration live in `firebaseClient.ts`; this module
 * only consumes them. The Firestore collection "forum-messages" stores community
 * chat messages.
 *
 * Authentication no longer lives here. `auth.ts` is the single Auth_Service
 * module, and the three names this module used to implement are re-exported
 * below purely so callers written against the old import path keep working for
 * one release.
 */

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
import { getFirebaseApp } from './firebaseClient';
import { ForumMessage } from './types';

// ─── Initialization ────────────────────────────────────────────────────────────

let db: Firestore;

export function getDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}

// ─── Deprecated auth re-exports ────────────────────────────────────────────────

/**
 * @deprecated Import from `@/lib/auth` instead. These are thin re-exports kept
 * for one release; note that `signInWithGoogle` now returns a
 * `GoogleSignInOutcome` rather than a `User | null`, and `onAuthChange` emits an
 * `AuthSession | null`.
 */
export { signInWithGoogle, signOut, onAuthChange } from './auth';

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
