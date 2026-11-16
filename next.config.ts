import type { NextConfig } from 'next';
import { relative, resolve } from 'node:path';

const externalBuildPath = process.env.NEXT_BUILD_DIR?.trim();
const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(externalBuildPath ? { distDir: relative(process.cwd(), resolve(externalBuildPath)) } : {}),
};

if (externalBuildPath && !nextConfig.distDir) throw new Error('NEXT_BUILD_DIR must point to a separate build output directory.');

export default nextConfig;
