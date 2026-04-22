export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'user' | 'admin';
  createdAt: Date;
}

const users = new Map<string, User>();

export function getUsers(): Map<string, User> { return users; }
export function getUserByUsername(username: string): User | undefined {
  return Array.from(users.values()).find(u => u.username === username);
}
export function getUserById(id: string): User | undefined { return users.get(id); }
export function addUser(user: User): void { users.set(user.id, user); }
export function clearUsers(): void { users.clear(); }
export function deleteUser(id: string): void { users.delete(id); }
export function getAllUsers(): User[] { return Array.from(users.values()); }
