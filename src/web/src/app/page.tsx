import Link from 'next/link';

const qualityPatterns = [
  {
    label: 'Spec-driven',
    text: 'Agents start from intent and turn it into clear, inspectable work.',
  },
  {
    label: 'Test-driven',
    text: 'Quality is not a final checkbox. Tests become the rails for the work.',
  },
  {
    label: 'Critic loop',
    text: 'Reviewer agents challenge the result before it reaches you.',
  },
];

const worldStages = ['Intent', 'Spec', 'Tests', 'Code', 'Critic', 'Preview'];

function LiliputianWorld(): React.JSX.Element {
  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="absolute -inset-8 rounded-[3rem] bg-[radial-gradient(circle_at_30%_10%,rgba(59,130,246,0.28),transparent_34%),radial-gradient(circle_at_80%_30%,rgba(168,85,247,0.24),transparent_32%),radial-gradient(circle_at_50%_90%,rgba(34,211,238,0.22),transparent_36%)] blur-2xl" />
      <div className="relative overflow-hidden rounded-[2.25rem] border border-white/80 bg-white/85 p-4 shadow-2xl shadow-blue-950/15 backdrop-blur">
        <svg
          viewBox="0 0 900 640"
          role="img"
          aria-label="A futuristic Liliput world where tiny software agents build and test an application"
          className="h-auto w-full"
        >
          <defs>
            <linearGradient id="skyGlow" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#eff6ff" />
              <stop offset="48%" stopColor="#ffffff" />
              <stop offset="100%" stopColor="#f5f3ff" />
            </linearGradient>
            <linearGradient id="appCore" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="52%" stopColor="#2563eb" />
              <stop offset="100%" stopColor="#7c3aed" />
            </linearGradient>
            <linearGradient id="agentSuit" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#0f172a" />
              <stop offset="100%" stopColor="#1d4ed8" />
            </linearGradient>
            <filter id="worldShadow" x="-20%" y="-20%" width="140%" height="150%">
              <feDropShadow dx="0" dy="18" stdDeviation="22" floodColor="#0f172a" floodOpacity="0.18" />
            </filter>
            <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect width="900" height="640" rx="44" fill="url(#skyGlow)" />
          <circle cx="690" cy="118" r="74" fill="#dbeafe" opacity="0.72" />
          <circle cx="736" cy="106" r="28" fill="#bfdbfe" opacity="0.75" />
          <circle cx="112" cy="118" r="54" fill="#ede9fe" opacity="0.8" />
          <path
            d="M70 214 C190 150 250 250 360 188 C470 126 520 230 626 174 C740 114 796 170 846 144"
            fill="none"
            stroke="#bfdbfe"
            strokeWidth="10"
            strokeLinecap="round"
            opacity="0.58"
          >
            <animate attributeName="stroke-dasharray" values="18 30;28 20;18 30" dur="7s" repeatCount="indefinite" />
          </path>

          <g filter="url(#worldShadow)">
            <ellipse cx="452" cy="530" rx="325" ry="58" fill="#c7d2fe" opacity="0.42" />
            <path
              d="M190 441 C228 372 316 350 388 380 C446 315 564 322 616 390 C702 382 770 424 786 496 C652 570 352 596 148 506 C150 484 164 461 190 441Z"
              fill="#f8fafc"
              stroke="#dbeafe"
              strokeWidth="4"
            />
            <path
              d="M170 499 C310 548 616 548 786 496 C775 548 718 584 632 596 L302 594 C224 584 178 552 170 499Z"
              fill="#e0f2fe"
              stroke="#bae6fd"
              strokeWidth="3"
            />
          </g>

          <g className="origin-center animate-pulse" filter="url(#softGlow)">
            <rect x="344" y="212" width="212" height="170" rx="30" fill="url(#appCore)" />
            <rect x="372" y="244" width="156" height="24" rx="12" fill="#ffffff" opacity="0.82" />
            <rect x="372" y="286" width="112" height="18" rx="9" fill="#bfdbfe" opacity="0.9" />
            <rect x="372" y="320" width="134" height="18" rx="9" fill="#bfdbfe" opacity="0.75" />
            <circle cx="514" cy="330" r="13" fill="#86efac" />
            <path d="M508 330 L513 335 L523 323" fill="none" stroke="#052e16" strokeWidth="4" strokeLinecap="round" />
          </g>

          <g>
            {worldStages.map((stage, index) => {
              const x = 156 + index * 118;
              const y = index % 2 === 0 ? 124 : 158;

              return (
                <g key={stage}>
                  <circle cx={x} cy={y} r="35" fill="#ffffff" stroke="#dbeafe" strokeWidth="3" />
                  <circle cx={x} cy={y} r="23" fill={index % 2 === 0 ? '#dbeafe' : '#ede9fe'} />
                  <text x={x} y={y + 58} textAnchor="middle" fill="#334155" fontSize="15" fontWeight="800">
                    {stage}
                  </text>
                </g>
              );
            })}
          </g>

          <path
            d="M178 354 C258 308 300 382 380 338 C450 300 492 394 570 344 C628 306 690 330 738 292"
            fill="none"
            stroke="#60a5fa"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray="12 18"
            opacity="0.75"
          >
            <animate attributeName="stroke-dashoffset" from="0" to="-120" dur="3.8s" repeatCount="indefinite" />
          </path>

          <Agent x={210} y={386} suit="#1d4ed8" label="SPEC" tool="scroll" />
          <Agent x={450} y={414} suit="#6d28d9" label="TEST" tool="flask" />
          <Agent x={668} y={376} suit="#0f766e" label="CRITIC" tool="lens" />

          <g filter="url(#worldShadow)">
            <rect x="88" y="438" width="144" height="48" rx="18" fill="#ffffff" stroke="#dbeafe" strokeWidth="3" />
            <text x="160" y="468" textAnchor="middle" fill="#1d4ed8" fontSize="18" fontWeight="900">
              SPEC FIRST
            </text>
            <rect x="354" y="486" width="160" height="48" rx="18" fill="#ffffff" stroke="#dbeafe" strokeWidth="3" />
            <text x="434" y="516" textAnchor="middle" fill="#6d28d9" fontSize="18" fontWeight="900">
              TEST RAILS
            </text>
            <rect x="600" y="440" width="172" height="48" rx="18" fill="#ffffff" stroke="#ccfbf1" strokeWidth="3" />
            <text x="686" y="470" textAnchor="middle" fill="#0f766e" fontSize="18" fontWeight="900">
              CRITIC GATE
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}

function Agent({
  x,
  y,
  suit,
  label,
  tool,
}: {
  x: number;
  y: number;
  suit: string;
  label: string;
  tool: 'scroll' | 'flask' | 'lens';
}): React.JSX.Element {
  return (
    <g filter="url(#worldShadow)">
      <ellipse cx={x} cy={y + 92} rx="56" ry="16" fill="#94a3b8" opacity="0.28" />
      <circle cx={x} cy={y} r="38" fill="#fde68a" stroke="#f59e0b" strokeWidth="3" />
      <path d={`M${x - 23} ${y + 10} C${x - 5} ${y + 28} ${x + 8} ${y + 28} ${x + 25} ${y + 10}`} fill="none" stroke="#92400e" strokeWidth="5" strokeLinecap="round" />
      <circle cx={x - 14} cy={y - 3} r="5" fill="#0f172a" />
      <circle cx={x + 15} cy={y - 3} r="5" fill="#0f172a" />
      <rect x={x - 40} y={y + 36} width="80" height="82" rx="24" fill={suit} />
      <rect x={x - 28} y={y + 55} width="56" height="28" rx="12" fill="#ffffff" opacity="0.92" />
      <text x={x} y={y + 75} textAnchor="middle" fill={suit} fontSize="12" fontWeight="900">
        {label}
      </text>
      <path d={`M${x - 36} ${y + 58} L${x - 72} ${y + 36}`} stroke={suit} strokeWidth="11" strokeLinecap="round" />
      <path d={`M${x + 36} ${y + 58} L${x + 72} ${y + 36}`} stroke={suit} strokeWidth="11" strokeLinecap="round" />
      <path d={`M${x - 20} ${y + 116} L${x - 30} ${y + 154}`} stroke="#0f172a" strokeWidth="13" strokeLinecap="round" />
      <path d={`M${x + 20} ${y + 116} L${x + 30} ${y + 154}`} stroke="#0f172a" strokeWidth="13" strokeLinecap="round" />
      <Tool x={x + 78} y={y + 32} tool={tool} suit={suit} />
    </g>
  );
}

function Tool({
  x,
  y,
  tool,
  suit,
}: {
  x: number;
  y: number;
  tool: 'scroll' | 'flask' | 'lens';
  suit: string;
}): React.JSX.Element {
  if (tool === 'scroll') {
    return (
      <g>
        <rect x={x - 20} y={y - 18} width="40" height="52" rx="8" fill="#ffffff" stroke="#cbd5e1" strokeWidth="3" />
        <path d={`M${x - 10} ${y - 4} H${x + 10} M${x - 10} ${y + 10} H${x + 8} M${x - 10} ${y + 24} H${x + 4}`} stroke={suit} strokeWidth="4" strokeLinecap="round" />
      </g>
    );
  }

  if (tool === 'flask') {
    return (
      <g>
        <path d={`M${x - 10} ${y - 22} H${x + 10} M${x} ${y - 20} V${y + 6} L${x - 22} ${y + 36} H${x + 22} L${x} ${y + 6}`} fill="#ffffff" stroke="#cbd5e1" strokeWidth="3" strokeLinejoin="round" />
        <path d={`M${x - 12} ${y + 18} H${x + 12}`} stroke={suit} strokeWidth="6" strokeLinecap="round" />
      </g>
    );
  }

  return (
    <g>
      <circle cx={x - 4} cy={y - 2} r="20" fill="#ffffff" stroke="#cbd5e1" strokeWidth="4" />
      <circle cx={x - 4} cy={y - 2} r="10" fill="#ccfbf1" />
      <path d={`M${x + 12} ${y + 14} L${x + 34} ${y + 36}`} stroke={suit} strokeWidth="8" strokeLinecap="round" />
    </g>
  );
}

export default function LandingPage(): React.JSX.Element {
  return (
    <main className="min-h-full overflow-hidden bg-[#fbfdff] font-sans text-slate-950">
      <section className="relative">
        <div className="absolute inset-0 bg-[linear-gradient(115deg,rgba(239,246,255,0.95),rgba(255,255,255,0.9)_42%,rgba(245,243,255,0.9)),radial-gradient(circle_at_15%_20%,rgba(59,130,246,0.18),transparent_28%),radial-gradient(circle_at_85%_8%,rgba(168,85,247,0.16),transparent_30%)]" />
        <div className="absolute left-1/2 top-20 h-64 w-64 -translate-x-1/2 rounded-full bg-cyan-200/30 blur-3xl" />

        <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-6 sm:px-10 lg:px-12">
          <nav className="flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3" aria-label="Liliput home">
              <span className="relative flex size-12 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-xl shadow-slate-950/20">
                <span className="absolute -right-1 -top-1 size-3 rounded-full bg-cyan-300 shadow-lg shadow-cyan-300/70" />
                <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7">
                  <path d="M6 25V12L10 9L14 12L18 8L22 12L26 9V25H6Z" fill="currentColor" />
                  <path d="M11 25V18C11 15.8 12.8 14 15 14H17C19.2 14 21 15.8 21 18V25" fill="#38bdf8" />
                </svg>
              </span>
              <span>
                <span className="block text-xl font-black tracking-tight text-slate-950">Liliput</span>
                <span className="block text-[0.7rem] font-black uppercase tracking-[0.22em] text-blue-600">
                  Agent world
                </span>
              </span>
            </Link>

            <Link
              href="/dashboard"
              className="rounded-full border border-slate-200 bg-white/80 px-5 py-2.5 text-sm font-black text-slate-800 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            >
              Dashboard
            </Link>
          </nav>

          <div className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[0.92fr_1.08fr] lg:py-8">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-4 py-2 text-sm font-black text-blue-700 shadow-sm shadow-blue-950/5 backdrop-blur">
                <span className="size-2 rounded-full bg-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.95)]" />
                Autonomous software factory
              </div>

              <div className="space-y-5">
                <h1 className="max-w-4xl text-5xl font-black leading-[0.96] tracking-tight sm:text-6xl lg:text-7xl">
                  <span className="block">A tiny world of agents</span>
                  <span className="block bg-gradient-to-r from-blue-700 via-violet-700 to-slate-950 bg-clip-text text-transparent">
                    building the software you want.
                  </span>
                </h1>
                <p className="max-w-2xl text-xl leading-8 text-slate-600">
                  Liliput turns an idea into high-quality software through a full agent
                  factory: specs, tests, implementation, critic review, preview deployment,
                  and release-ready output.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/dashboard"
                  className="group inline-flex items-center justify-center rounded-full bg-slate-950 px-8 py-4 text-base font-black text-white shadow-2xl shadow-slate-950/20 transition hover:-translate-y-1 hover:bg-blue-700"
                >
                  Enter the factory
                  <span className="ml-2 transition group-hover:translate-x-1" aria-hidden="true">
                    -&gt;
                  </span>
                </Link>
                <div className="inline-flex items-center justify-center rounded-full border border-white bg-white/70 px-6 py-4 text-sm font-black text-slate-600 shadow-sm backdrop-blur">
                  Spec &gt; Test &gt; Build &gt; Critic &gt; Preview
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {qualityPatterns.map((pattern) => (
                  <div
                    key={pattern.label}
                    className="rounded-[1.6rem] border border-white bg-white/75 p-5 shadow-lg shadow-blue-950/5 backdrop-blur transition hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-950/10"
                  >
                    <div className="mb-4 h-1.5 w-12 rounded-full bg-gradient-to-r from-blue-500 to-violet-500" />
                    <h2 className="text-base font-black text-slate-950">{pattern.label}</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{pattern.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <LiliputianWorld />
          </div>
        </div>
      </section>
    </main>
  );
}
