import { test as base } from '@playwright/test';

// Extended test fixture that resets the in-memory user store before each test
export const test = base.extend({
  page: async ({ page }, use) => {
    // Reset the user store before each test for isolation
    const apiUrl = process.env.PLAYWRIGHT_BASE_URL
      ? new URL(process.env.PLAYWRIGHT_BASE_URL).origin.replace(':3000', ':5001')
      : 'http://localhost:5001';
    await page.request.post(`${apiUrl}/api/test/reset`);
    await use(page);
  },
});

export { expect } from '@playwright/test';
