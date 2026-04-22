import { beforeEach } from 'vitest';
import { clearUsers } from '../src/models/user-store.js';

beforeEach(() => {
  clearUsers();
});
