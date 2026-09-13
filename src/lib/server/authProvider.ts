export type AuthProvider = 'cognito' | 'logto';

export function configuredAuthProvider(): AuthProvider {
  return process.env.AUTH_PROVIDER?.trim().toLowerCase() === 'logto'
    ? 'logto'
    : 'cognito';
}

export function isLogtoAuth(): boolean {
  return configuredAuthProvider() === 'logto';
}
