import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The existing .next output in this OneDrive checkout contains read-only reparse points.
  // Use a fresh build path so Next's cleanDistDir phase does not loop on Windows EPERM.
  distDir: '.next-build',
};
export default nextConfig;
