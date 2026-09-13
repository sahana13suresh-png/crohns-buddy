import { describe, expect, it } from 'vitest';

import { SERVER_RUNTIME_ENV_KEYS } from './next.config.mjs';

describe('Amplify server runtime environment', () => {
  it('embeds the Logto cutover configuration in the server bundle', () => {
    expect(SERVER_RUNTIME_ENV_KEYS).toEqual(
      expect.arrayContaining([
        'AUTH_PROVIDER',
        'AUTH_SELF_REGISTRATION_ENABLED',
        'AUTH_SOCIAL_PROVIDERS',
        'LOGTO_APP_ID',
        'LOGTO_APP_SECRET',
        'LOGTO_ENDPOINT',
      ]),
    );
  });
});
