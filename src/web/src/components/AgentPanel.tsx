'use client';

import { useState } from 'react';
import type { Agent, AgentRole, AgentStatus } from '@shared/types';

interface AgentPanelProps {
  agents: Agent[];
}

const ROLE_CONFIG: Record<AgentRole, { icon: string; color: string }> = {
  architect: { icon: '📐', color: 'text-blue-400' },
  coder: { icon: '💻', color: 'text-green-400' },
  builder: { icon: '🔨', color: 'text-orange-400' },
  tester: { icon: '🧪', color: 'text-purple-400' },
  deployer: { icon: '🚀', color: 'text-red-400' },
  reviewer: { icon: '👁️', color: 'text-cyan-400' },
  researcher: { icon: '🔍', color: 'text-yellow-400' },
};

const STATUS_STYLES: Record<AgentStatus, { bg: string; text: string; label: string }> = {
  idle: { bg: 'bg-gray-700', text: 'text-gray-400', label: 'Idle' },
  working: { bg: 'bg-yellow-900/40', text: 'text-yellow-400', label: 'Working' },
  completed: { bg: 'bg-green-900/40', text: 'text-green-400', label: 'Done' },
  failed: { bg: 'bg-red-900/40', text: 'text-red-400', label: 'Failed' },
  waiting: { bg: 'bg-blue-900/40', text: 'text-blue-400', label: 'Waiting' },
};

export default function AgentPanel({ agents }: AgentPanelProps) {
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

  const toggleLogs = (agentId: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  if (agents.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        <div className="text-center">
          <div className="text-4xl mb-3">🏰</div>
          <p>No agents active</p>
          <p className="text-xs mt-1">Send a task to wake the Liliputians</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-2">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
        Active Agents
      </h3>
      {agents.map((agent) => {
        const role = ROLE_CONFIG[agent.role];
        const status = STATUS_STYLES[agent.status];
        const isExpanded = expandedLogs.has(agent.id);

        return (
          <div
            key={agent.id}
            className={`rounded-lg border border-[#1a1a2e] ${status.bg} p-3`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span>{role.icon}</span>
                <span className={`text-sm font-medium ${role.color}`}>
                  {agent.name}
                </span>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${status.text} border border-current/20`}>
                {status.label}
              </span>
            </div>

            {agent.currentAction && (
              <p className="text-xs text-gray-400 mt-1 truncate">
                {agent.currentAction}
              </p>
            )}

            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-[#1a1a2e] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-green-500 rounded-full transition-all duration-500"
                style={{ width: `${agent.progress}%` }}
              />
            </div>

            {/* Logs toggle */}
            {agent.logs.length > 0 && (
              <button
                onClick={() => toggleLogs(agent.id)}
                className="text-xs text-gray-500 hover:text-gray-300 mt-2 transition-colors"
              >
                {isExpanded ? '▼' : '▶'} Logs ({agent.logs.length})
              </button>
            )}

            {isExpanded && (
              <div className="mt-2 max-h-40 overflow-y-auto bg-[#0a0a0f] rounded p-2 text-xs font-mono space-y-0.5">
                {agent.logs.slice(-20).map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.level === 'error'
                        ? 'text-red-400'
                        : log.level === 'warn'
                        ? 'text-yellow-400'
                        : 'text-gray-500'
                    }
                  >
                    <span className="text-gray-600">
                      {new Date(log.timestamp).toLocaleTimeString()}{' '}
                    </span>
                    {log.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
