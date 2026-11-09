import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server for the Docker image (smaller, lower idle memory).
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@le/shared'],
  poweredByHeader: false,
};

export default config;
