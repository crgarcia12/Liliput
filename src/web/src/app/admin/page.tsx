'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  username: string;
  role: string;
  createdAt: string;
}

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(dateStr));
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => {
        if (res.status === 401) {
          router.push('/login');
          return null;
        }
        if (!res.ok) throw new Error('Failed');
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        if (data.role !== 'admin') {
          setDenied(true);
          setLoading(false);
          return;
        }
        return fetch('/api/admin/users')
          .then((res) => {
            if (!res.ok) throw new Error('Failed');
            return res.json();
          })
          .then((userList) => setUsers(userList));
      })
      .catch(() => setDenied(true))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <main className="flex min-h-[80vh] items-center justify-center">
        <p className="text-gray-600">Loading users...</p>
      </main>
    );
  }

  if (denied) {
    return (
      <main className="flex min-h-[80vh] flex-col items-center justify-center gap-2">
        <h1 className="text-2xl font-bold text-red-600">Access Denied</h1>
        <p className="text-gray-600">You do not have permission to view this page.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Users</h1>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="px-4 py-3 text-sm font-medium text-gray-600">Username</th>
            <th className="px-4 py-3 text-sm font-medium text-gray-600">Role</th>
            <th className="px-4 py-3 text-sm font-medium text-gray-600">Member Since</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.username} className="border-b border-gray-100">
              <td className="px-4 py-3 text-gray-900">{u.username}</td>
              <td className="px-4 py-3 text-gray-700">{u.role}</td>
              <td className="px-4 py-3 text-gray-700">{formatDate(u.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
