import '@testing-library/jest-dom';

// Component tests exercise the configured Auth_UI by default. Individual
// configuration tests override or remove these values explicitly.
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??= 'test-api-key';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= 'test-project';
process.env.NEXT_PUBLIC_AUTH_ENABLED ??= 'true';
process.env.NEXT_PUBLIC_AUTH_SELF_REGISTRATION_ENABLED ??= 'false';
process.env.COGNITO_AWS_REGION ??= 'us-east-1';
process.env.COGNITO_USER_POOL_ID ??= 'us-east-1_test';
process.env.COGNITO_CLIENT_ID ??= 'test-client';
process.env.COGNITO_DOMAIN ??= 'https://test.auth.us-east-1.amazoncognito.com';
process.env.AUTH_ALLOWED_ORIGINS ??= 'https://example.test,http://127.0.0.1:3000';
process.env.AUTH_SOCIAL_PROVIDERS ??= 'Google';
process.env.AUTH_SELF_REGISTRATION_ENABLED ??= 'false';

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
