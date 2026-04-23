import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001'}/api/:path*` },
    ];
  },
  // Allow Three.js and WebSocket connections
  serverExternalPackages: ['three'],
};

export default nextConfig;
