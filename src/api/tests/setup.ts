// Test setup — runs before each test file
import { resetStore } from '../src/stores/task-store.js';

beforeEach(() => {
  resetStore();
});
