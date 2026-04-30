/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/admin',
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: '/dashboard/analytics', destination: '/dashboard', permanent: false },
    ];
  },
};

module.exports = nextConfig;
