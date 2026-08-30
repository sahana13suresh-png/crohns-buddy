/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),
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
