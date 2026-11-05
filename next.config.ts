import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Carrier invoice CSVs are uploaded through a server action (1MB by default; Vercel allows 4.5MB per request).
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
};

export default nextConfig;
