'use client';

import { useState } from 'react';
import { login } from '@/lib/api-client';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(username, password);
      router.push('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-[#1a1a2e] rounded-lg shadow-xl p-8 border border-[#2a2a4e]">
          <h1 className="text-3xl font-bold text-center mb-2 text-[#e0e0e8]">
            Liliput
          </h1>
          <p className="text-center text-[#a0a0a8] mb-8">
            Agent Orchestrator Platform
          </p>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-[#d0d0d8] mb-2">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#3a3a5e] rounded text-[#e0e0e8] placeholder-[#606080] focus:outline-none focus:border-[#5a5a8e]"
                disabled={loading}
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-[#d0d0d8] mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#3a3a5e] rounded text-[#e0e0e8] placeholder-[#606080] focus:outline-none focus:border-[#5a5a8e]"
                disabled={loading}
                required
              />
            </div>

            {error && (
              <div className="p-4 bg-red-900/20 border border-red-800/50 rounded text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            >
              {loading ? 'Logging in...' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
