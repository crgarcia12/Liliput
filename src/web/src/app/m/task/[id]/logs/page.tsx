'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import ActivityLog from '../../../../../components/ActivityLog';
import { useMobileTask } from '../useMobileTask';

export default function MobileTaskLogsPage() {
  const params = useParams();
  const taskId = params.id as string;
  const m = useMobileTask(taskId);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <Link
          href={`/m/task/${taskId}`}
          className="text-gray-400 hover:text-gray-200 px-2 py-2 -ml-2 text-base"
          aria-label="Back"
        >
          ←
        </Link>
        <h1 className="text-sm font-bold truncate flex-1 min-w-0 text-gray-200">
          Activity ·{' '}
          <span className="text-cyan-400">{m.task?.title || 'Task'}</span>
        </h1>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${m.connected ? 'bg-green-400' : 'bg-red-500'}`}
          title={m.connected ? 'Connected' : 'Disconnected'}
        />
      </header>

      <main className="flex-1 min-h-0 p-2">
        <ActivityLog entries={m.taskActivity} title="Live Activity" />
      </main>
    </div>
  );
}
