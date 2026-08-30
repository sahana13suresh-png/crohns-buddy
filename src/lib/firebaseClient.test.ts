import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `firebaseConfig` is read from the environment at module load, so each case
 * resets the module registry and re-imports.
 */
async function loadClient() {
  vi.resetModules();
  return import('./firebaseClient');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('firebaseClient', () => {
  it('reads every config value from NEXT_PUBLIC_FIREBASE_* environment variables', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'key-1');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.firebaseapp.com');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'project-1');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', 'bucket-1');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', 'sender-1');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'app-1');

    const { firebaseConfig } = await loadClient();

    expect(firebaseConfig).toStrictEqual({
      apiKey: 'key-1',
      authDomain: 'example.firebaseapp.com',
      projectId: 'project-1',
      storageBucket: 'bucket-1',
      messagingSenderId: 'sender-1',
      appId: 'app-1',
    });
  });

  it('reports configured when the API key is present', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'key-1');

    const { isFirebaseConfigured } = await loadClient();

    expect(isFirebaseConfigured()).toBe(true);
  });

  it('treats an absent API key as not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', undefined);

    const { isFirebaseConfigured } = await loadClient();

    expect(isFirebaseConfigured()).toBe(false);
  });

  it('treats an empty API key as not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', '');

    const { isFirebaseConfigured } = await loadClient();

    expect(isFirebaseConfigured()).toBe(false);
  });
});
