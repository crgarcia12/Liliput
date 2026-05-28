import Link from 'next/link';

const steps = [
  {
    label: 'Describe the goal',
    text: 'Give Liliput a product idea, bug, or modernization task in plain language.',
  },
  {
    label: 'Agents split the work',
    text: 'PM, developer, reviewer, and release agents turn it into coordinated GitHub work.',
  },
  {
    label: 'Ship in parallel',
    text: 'Many repositories and many features can move at once on Kubernetes.',
  },
];

function AgentAnimation(): React.JSX.Element {
  return (
    <div className="relative mx-auto w-full max-w-4xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white p-6 shadow-2xl shadow-blue-950/10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(56,189,248,0.18),transparent_28%),radial-gradient(circle_at_80%_20%,rgba(129,140,248,0.16),transparent_25%),linear-gradient(180deg,rgba(248,250,252,0.85),rgba(255,255,255,0))]" />
      <svg
        viewBox="0 0 920 420"
        role="img"
        aria-label="Animated diagram showing one request being split across Kubernetes agents and shipped to multiple projects"
        className="relative h-auto w-full"
      >
        <defs>
          <linearGradient id="agentGradient" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
          <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="16" stdDeviation="18" floodColor="#1e293b" floodOpacity="0.16" />
          </filter>
        </defs>

        <rect x="28" y="42" width="210" height="124" rx="28" fill="#f8fafc" stroke="#dbeafe" filter="url(#softShadow)" />
        <text x="132" y="85" textAnchor="middle" fill="#0f172a" fontSize="22" fontWeight="700">
          You ask
        </text>
        <text x="132" y="118" textAnchor="middle" fill="#475569" fontSize="15">
          &quot;Build this feature&quot;
        </text>
        <text x="132" y="143" textAnchor="middle" fill="#64748b" fontSize="13">
          one natural-language brief
        </text>

        <path d="M248 104 C310 104 318 104 380 104" stroke="#93c5fd" strokeWidth="5" strokeLinecap="round" strokeDasharray="10 14">
          <animate attributeName="stroke-dashoffset" from="0" to="-96" dur="2.6s" repeatCount="indefinite" />
        </path>

        <g filter="url(#softShadow)">
          <rect x="390" y="30" width="176" height="70" rx="22" fill="url(#agentGradient)" />
          <rect x="390" y="125" width="176" height="70" rx="22" fill="url(#agentGradient)" opacity="0.94" />
          <rect x="390" y="220" width="176" height="70" rx="22" fill="url(#agentGradient)" opacity="0.88" />
          <rect x="390" y="315" width="176" height="70" rx="22" fill="url(#agentGradient)" opacity="0.82" />
        </g>

        {['PM Agent', 'Dev Agent', 'Reviewer', 'Release'].map((name, index) => (
          <g key={name}>
            <circle cx="422" cy={65 + index * 95} r="11" fill="#bfdbfe">
              <animate attributeName="r" values="9;13;9" dur="2.4s" begin={`${index * 0.25}s`} repeatCount="indefinite" />
            </circle>
            <text x="450" y={71 + index * 95} fill="white" fontSize="18" fontWeight="700">
              {name}
            </text>
          </g>
        ))}

        <path d="M575 65 C635 65 650 58 706 58" stroke="#c4b5fd" strokeWidth="5" strokeLinecap="round" strokeDasharray="9 13">
          <animate attributeName="stroke-dashoffset" from="0" to="-88" dur="2.3s" repeatCount="indefinite" />
        </path>
        <path d="M575 160 C635 160 650 168 706 168" stroke="#93c5fd" strokeWidth="5" strokeLinecap="round" strokeDasharray="9 13">
          <animate attributeName="stroke-dashoffset" from="0" to="-88" dur="2.5s" repeatCount="indefinite" />
        </path>
        <path d="M575 255 C635 255 650 278 706 278" stroke="#86efac" strokeWidth="5" strokeLinecap="round" strokeDasharray="9 13">
          <animate attributeName="stroke-dashoffset" from="0" to="-88" dur="2.7s" repeatCount="indefinite" />
        </path>

        {[
          ['Repo A', 'Feature 1', 58],
          ['Repo B', 'Bug fix', 168],
          ['Repo C', 'Upgrade', 278],
        ].map(([repo, task, y], index) => (
          <g key={repo} filter="url(#softShadow)">
            <rect x="704" y={Number(y) - 36} width="176" height="72" rx="20" fill="#ffffff" stroke="#dbeafe" />
            <text x="792" y={Number(y) - 5} textAnchor="middle" fill="#0f172a" fontSize="18" fontWeight="700">
              {repo}
            </text>
            <text x="792" y={Number(y) + 21} textAnchor="middle" fill="#64748b" fontSize="14">
              {task}
            </text>
            <circle cx="850" cy={Number(y) - 18} r="6" fill="#22c55e">
              <animate attributeName="opacity" values="0.35;1;0.35" dur="1.8s" begin={`${index * 0.35}s`} repeatCount="indefinite" />
            </circle>
          </g>
        ))}

        <text x="478" y="410" textAnchor="middle" fill="#475569" fontSize="16" fontWeight="700">
          Kubernetes keeps the agents running, isolated, and parallel.
        </text>
      </svg>
    </div>
  );
}

export default function LandingPage(): React.JSX.Element {
  return (
    <main className="min-h-full bg-white font-sans text-slate-950">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-6 py-8 sm:px-10 lg:px-12">
        <nav className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3" aria-label="Liliput home">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-blue-600 text-2xl text-white shadow-lg shadow-blue-600/25">
              🏰
            </span>
            <span className="text-xl font-black tracking-tight text-slate-950">Liliput</span>
          </Link>
          <Link
            href="/dashboard"
            className="rounded-full border border-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
          >
            Dashboard
          </Link>
        </nav>

        <div className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-8">
            <div className="inline-flex rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700">
              Autonomous software delivery, at team scale
            </div>
            <div className="space-y-5">
              <h1 className="max-w-4xl text-5xl font-black leading-[1.02] tracking-tight text-slate-950 sm:text-6xl lg:text-7xl">
                Your entire Software Development department as Kubernetes agents.
              </h1>
              <p className="max-w-2xl text-xl leading-8 text-slate-600">
                Liliput turns product requests into coordinated agent work: planning, coding,
                reviewing, releasing, and reporting across many projects and many features at the
                same time.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-full bg-slate-950 px-7 py-4 text-base font-black text-white shadow-xl shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-blue-700"
              >
                Open Dashboard
                <span className="ml-2" aria-hidden="true">→</span>
              </Link>
              <Link
                href="/new"
                className="inline-flex items-center justify-center rounded-full border border-slate-200 px-7 py-4 text-base font-bold text-slate-700 transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
              >
                Start a workstream
              </Link>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {steps.map((step, index) => (
                <div key={step.label} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="mb-4 flex size-9 items-center justify-center rounded-full bg-white text-sm font-black text-blue-700 shadow-sm">
                    {index + 1}
                  </div>
                  <h2 className="text-base font-black text-slate-950">{step.label}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{step.text}</p>
                </div>
              ))}
            </div>
          </div>

          <AgentAnimation />
        </div>
      </section>
    </main>
  );
}
