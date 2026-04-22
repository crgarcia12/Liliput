'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => setAuthenticated(res.ok))
      .catch(() => setAuthenticated(false));
  }, []);

  return (
    <main className="flex min-h-[80vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-4 text-4xl font-bold text-gray-900">UserAuth</h1>
      <p className="mb-8 max-w-md text-lg text-gray-600">
        A simple authentication demo application.
      </p>
      {authenticated === true && (
        <Link
          href="/profile"
          className="rounded bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700"
        >
          Go to Profile
        </Link>
      )}
      {authenticated === false && (
        <div className="flex gap-4">
          <Link
            href="/login"
            className="rounded bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700"
          >
            Login
          </Link>
          <Link
            href="/register"
            className="rounded border border-blue-600 px-6 py-2.5 font-medium text-blue-600 hover:bg-blue-50"
          >
            Register
          </Link>
        </div>
      )}
    </main>
  );
}
