import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      DB_PATH: ':memory:',
      // Deterministic seed for the auth tests. Without this, the new
      // ensureDefaultAdminUser() generates a random password on first boot.
      DEFAULT_ADMIN_PASSWORD: 'TestPassword-123456',
      // Use 4 rounds in tests — bcrypt's hashing dominates change-password
      // test runtime otherwise. 4 rounds is still a real bcrypt hash so the
      // verification path is exercised end-to-end.
      BCRYPT_ROUNDS: '4',
      // Stable secret so tokens are reproducible across runs.
      JWT_SECRET: 'test-jwt-secret-do-not-use-in-prod',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
});
