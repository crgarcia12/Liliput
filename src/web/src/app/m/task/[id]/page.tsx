'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Terminal from '../../../../components/Terminal';
import AgentPipeline from '../../../../components/AgentPipeline';
import { useMobileTask } from './useMobileTask';

export default function MobileTaskChatPage() {
  const params = useParams();
  const taskId = params.id as string;
  const m = useMobileTask(taskId);
  const [showSpec, setShowSpec] = useState(true);

  if (m.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl animate-pulse mb-4">🏰</div>
          <p className="text-gray-500">Loading task...</p>
        </div>
      </div>
    );
  }

  if (m.error && !m.task) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
        <div className="text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <p className="text-red-400">{m.error}</p>
        </div>
      </div>
    );
  }

  const task = m.task;
  const backHref = task?.workstreamId ? `/m/workstream/${task.workstreamId}` : '/m';
  const showSpecBanner = !!task?.spec;
  const canEditSpec = task?.status === 'specifying';
  const errorText = m.error || task?.errorMessage;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 bg-[#0d0d14] border-b border-[#1a1a2e]">
        <Link
          href={backHref}
          className="text-gray-400 hover:text-gray-200 px-2 py-2 -ml-2 text-base"
          aria-label="Back"
        >
          ←
        </Link>
        <h1 className="text-sm font-bold truncate flex-1 min-w-0 text-cyan-400">
          {task?.title || 'Task'}
        </h1>
        {task?.pullRequestUrl && (
          <a
            href={task.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white shrink-0"
            aria-label="Open pull request"
          >
            🔀 PR{task.pullRequestNumber ? ` #${task.pullRequestNumber}` : ''} ↗
          </a>
        )}
        {m.isWorking && (
          <button
            onClick={async () => {
              await m.cancelTask();
            }}
            disabled={m.actionPending !== null}
            className="text-[10px] px-2 py-1 rounded bg-orange-700 hover:bg-orange-600 text-white shrink-0 disabled:opacity-50"
            title="Stop the current agent turn"
          >
            {m.actionPending === 'cancel' ? '…' : '⏹'}
          </button>
        )}
        {task && task.status !== 'completed' && task.status !== 'discarded' && task.status !== 'failed' && task.status !== 'deleting' && task.status !== 'review' && (
          <button
            onClick={async () => {
              if (!confirm('Close this workstream? Branch + commits stay on the remote (no PR). Dev environment will be paused.')) return;
              await m.closeTask();
            }}
            disabled={m.actionPending !== null}
            className="text-[10px] px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white shrink-0 disabled:opacity-50"
            title="Close — keep branch + commits, no PR"
          >
            {m.actionPending === 'close' ? '…' : '🏁'}
          </button>
        )}
        {task?.status && (
          <span
            className={`text-[10px] px-2 py-0.5 rounded shrink-0 ${
              task.status === 'failed'
                ? 'bg-red-900/40 text-red-300 border border-red-800'
                : task.status === 'review'
                ? 'bg-amber-900/40 text-amber-300 border border-amber-700'
                : task.status === 'completed'
                ? 'bg-green-900/40 text-green-300 border border-green-800'
                : 'bg-[#1a1a2e] text-gray-400'
            }`}
          >
            {task.status}
          </span>
        )}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${m.connected ? 'bg-green-400' : 'bg-red-500'}`}
          title={m.connected ? 'Connected' : 'Disconnected'}
        />
      </header>

      {errorText && (
        <div className="px-3 py-2 bg-red-900/30 border-b border-red-800 text-red-300 text-xs flex items-center gap-2">
          <span>⚠️</span>
          <span className="flex-1 font-mono break-words">{errorText}</span>
          {m.error && (
            <button
              onClick={() => m.setError(null)}
              className="text-red-200 hover:text-white px-2 py-1"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {showSpecBanner && (
        <div className="border-b border-purple-800/50 bg-purple-950/20">
          <div className="flex items-center justify-between px-3 py-2 text-xs gap-2">
            <span className="text-purple-300 font-semibold truncate">
              📜 {canEditSpec ? `Spec ready${m.editingSpec ? ' — editing' : ''}` : 'Implementation spec'}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {canEditSpec && m.editingSpec ? (
                <>
                  <button
                    onClick={m.cancelEditSpec}
                    disabled={m.specSaving}
                    className="text-purple-300 hover:text-purple-100 px-3 py-2 min-h-[44px] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={m.saveSpec}
                    disabled={m.specSaving || !m.specDraft.trim()}
                    className="px-3 py-2 min-h-[44px] rounded bg-purple-800 hover:bg-purple-700 text-white text-xs disabled:opacity-50"
                  >
                    {m.specSaving ? 'Saving…' : '💾 Save'}
                  </button>
                </>
              ) : canEditSpec ? (
                <>
                  <button
                    onClick={() => {
                      m.startEditSpec();
                      setShowSpec(true);
                    }}
                    className="text-purple-300 hover:text-purple-100 px-3 py-2 min-h-[44px]"
                  >
                    ✎ Edit
                  </button>
                  <button
                    onClick={() => setShowSpec((s) => !s)}
                    className="text-purple-300 hover:text-purple-100 px-3 py-2 min-h-[44px]"
                  >
                    {showSpec ? 'Hide' : 'Show'}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowSpec((s) => !s)}
                  className="text-purple-300 hover:text-purple-100 px-3 py-2 min-h-[44px]"
                >
                  {showSpec ? 'Hide' : 'Show'}
                </button>
              )}
              {canEditSpec && (
                <button
                  onClick={m.approveSpec}
                  disabled={m.actionPending === 'approve' || m.specSaving}
                  className="px-3 py-2 min-h-[44px] rounded bg-purple-700 hover:bg-purple-600 text-white text-xs disabled:opacity-50"
                >
                  {m.actionPending === 'approve' ? 'Approving…' : '✓ Approve'}
                </button>
              )}
            </div>
          </div>
          {canEditSpec && m.editingSpec ? (
            <textarea
              value={m.specDraft}
              onChange={(e) => m.setSpecDraft(e.target.value)}
              spellCheck={false}
              className="mx-3 mb-3 block w-[calc(100%-1.5rem)] h-64 resize-y rounded border border-purple-800/50 bg-[#0a0a0f] px-3 py-2 text-[11px] text-gray-200 font-mono focus:outline-none focus:border-purple-500"
            />
          ) : (
            showSpec &&
            task?.spec && (
              <pre className="px-3 pb-3 max-h-64 overflow-y-auto text-[11px] text-gray-300 whitespace-pre-wrap font-mono">
                {task.spec}
              </pre>
            )
          )}
        </div>
      )}

      <main className="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <AgentPipeline pipeline={m.pipeline} />
        <div className="flex-1 min-h-0">
          <Terminal messages={m.allMessages} onSend={m.sendMessage} isWorking={m.isWorking} />
        </div>
      </main>

      <nav className="sticky bottom-0 z-10 flex items-stretch border-t border-[#1a1a2e] bg-[#0d0d14]">
        <Link
          href={`/m/task/${taskId}/logs`}
          className="flex-1 flex items-center justify-center gap-2 py-3 min-h-[44px] text-sm text-gray-300 hover:bg-[#1a1a2e] active:bg-[#1a1a2e]"
        >
          <span>📜</span>
          <span>Logs</span>
        </Link>
        <Link
          href={`/m/task/${taskId}/config`}
          className="flex-1 flex items-center justify-center gap-2 py-3 min-h-[44px] text-sm text-gray-300 hover:bg-[#1a1a2e] active:bg-[#1a1a2e] border-l border-[#1a1a2e]"
        >
          <span>⚙</span>
          <span>Config</span>
        </Link>
      </nav>
    </div>
  );
}
