export const SERVER_RUNTIME_ENV_KEYS = [
  'AUTH_ALLOWED_ORIGINS',
  'AUTH_PROVIDER',
  'AUTH_SELF_REGISTRATION_ENABLED',
  'AUTH_SOCIAL_PROVIDERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'BEDROCK_MODEL_ID',
  'COGNITO_AWS_REGION',
  'COGNITO_CLIENT_ID',
  'COGNITO_DOMAIN',
  'COGNITO_USER_POOL_ID',
  'CRON_SECRET',
  'LOGTO_APP_ID',
  'LOGTO_APP_SECRET',
  'LOGTO_ENDPOINT',
  'MEAL_PLAN_AWS_ACCESS_KEY_ID',
  'MEAL_PLAN_AWS_REGION',
  'MEAL_PLAN_AWS_SECRET_ACCESS_KEY',
  'MEAL_PLAN_TABLE_NAME',
  'PERSPECTIVE_API_KEY',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),
  webpack(config, { isServer, webpack }) {
    if (isServer) {
      const definitions = Object.fromEntries(
        SERVER_RUNTIME_ENV_KEYS.map((name) => [
          `process.env.${name}`,
          JSON.stringify(process.env[name] ?? ''),
        ]),
      );
      config.plugins.push(new webpack.DefinePlugin(definitions));
    }
    return config;
  },
  async headers() {
    return [
      {
        // Requirements 12.7, 12.8: instruct browsers to use HTTPS only, so an
        // unencrypted request is upgraded before it ever reaches a route
        // handler and therefore before any Meal_Plan_Store access.
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
