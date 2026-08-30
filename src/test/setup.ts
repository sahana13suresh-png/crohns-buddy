import '@testing-library/jest-dom';

// Component tests exercise the configured Auth_UI by default. Individual
// configuration tests override or remove these values explicitly.
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??= 'test-api-key';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= 'test-project';
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??= 'test.firebaseapp.com';

/**
 * jsdom implements no layout, so it ships no `Element.prototype.scrollIntoView`.
 * Components that scroll a newly rendered element into view therefore throw
 * "scrollIntoView is not a function" on render rather than failing any
 * assertion. Supplying a no-op keeps that call harmless; nothing asserts on
 * scrolling, which has no observable effect in jsdom anyway.
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
