import { useState, useEffect } from 'react';

const GITHUB_RELEASES_URL = 'https://github.com/generalizingai/Noah/releases/latest';
const GITHUB_API_LATEST   = 'https://api.github.com/repos/generalizingai/Noah/releases';

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
  published_at: string;
}

function fmtBytes(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function DownloadPage() {
  const [release, setRelease]   = useState<Release | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetch(GITHUB_API_LATEST)
      .then(r => r.json())
      .then((releases: Release[]) => {
        const noahRelease = releases.find(r => r.tag_name.startsWith('noah-v'));
        setRelease(noahRelease ?? null);
      })
      .catch(() => setRelease(null))
      .finally(() => setLoading(false));
  }, []);

  const dmg  = release?.assets.find(a => a.name.endsWith('.dmg'));
  const ver  = release ? release.tag_name.replace('noah-v', '') : null;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-white">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-4 pb-20 pt-32 text-center">
        <img
          src="/noah-logo.webp"
          alt="Noah"
          className="mb-6 h-20 w-auto opacity-90"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <h1 className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl">Noah for Mac</h1>
        <p className="mb-2 max-w-lg text-base text-gray-400">
          Your always-on AI assistant for work. Listens, remembers, and acts — right from your menu bar.
        </p>

        {loading ? (
          <div className="mt-10 h-12 w-56 animate-pulse rounded-full bg-white/10" />
        ) : dmg ? (
          <>
            <a
              href={dmg.browser_download_url}
              className="mt-10 inline-flex items-center gap-3 rounded-full bg-white px-8 py-3.5 text-base font-semibold text-black shadow-xl transition hover:bg-gray-100 active:scale-95"
            >
              <AppleIcon />
              Download for Mac
            </a>
            <p className="mt-3 text-xs text-gray-500">
              Version {ver} · {fmtBytes(dmg.size)} · macOS 12+
              {release?.published_at && ` · Released ${fmtDate(release.published_at)}`}
            </p>
          </>
        ) : (
          <a
            href={GITHUB_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 inline-flex items-center gap-3 rounded-full bg-white px-8 py-3.5 text-base font-semibold text-black shadow-xl transition hover:bg-gray-100"
          >
            <AppleIcon />
            View Releases on GitHub
          </a>
        )}

        <p className="mt-4 text-xs text-gray-600">
          Requires macOS 12 Monterey or later · Apple Silicon &amp; Intel
        </p>
      </section>

      {/* Installation steps */}
      <section className="mx-auto max-w-2xl px-4 pb-24">
        <h2 className="mb-8 text-center text-lg font-semibold text-gray-300">
          Install in three steps
        </h2>
        <ol className="space-y-5">
          {[
            { n: '1', title: 'Download', desc: 'Click the button above to download the Noah .dmg file.' },
            { n: '2', title: 'Install',  desc: 'Open the .dmg, drag Noah into your Applications folder, and eject the disk image.' },
            { n: '3', title: 'Launch',   desc: 'Open Noah from your Applications folder. Sign in with Google and start talking to your assistant.' },
          ].map(s => (
            <li key={s.n} className="flex items-start gap-4 rounded-xl border border-white/5 bg-white/3 p-5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold">
                {s.n}
              </span>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="mt-0.5 text-sm text-gray-400">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-8 text-center text-xs text-gray-600">
          First launch? If macOS shows a security warning, right-click Noah.app → Open.{' '}
          <a
            href="https://support.apple.com/en-us/102445"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-400"
          >
            Why does this happen?
          </a>
        </p>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-white/5 py-12 text-center">
        <p className="mb-4 text-sm text-gray-500">Questions or feedback?</p>
        <a
          href="https://discord.com/invite/ZutWMTJnwA"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-[#6C8EEF]/10 px-5 py-2.5 text-sm font-medium text-[#6C8EEF] transition hover:bg-[#6C8EEF]/20"
        >
          Join us on Discord
        </a>
      </section>
    </div>
  );
}

function AppleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 814 1000" fill="currentColor">
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-111.2c-48.3-70.5-87.4-176.6-87.4-277.2 0-175.2 114.4-268.1 226.7-268.1 59.8 0 109.6 39.5 147.2 39.5 35.8 0 92.2-41.7 160.6-41.7 24.9 0 108.2 2.6 168.6 75.7zm-126.7-102.5c26.7-31.5 45.5-76 45.5-120.5 0-6.2-.5-12.6-1.6-18.1-42.8 1.5-93.4 28.4-124.1 64.1-23.5 26.7-44.5 71-44.5 115.8 0 7.1 1.1 14.2 1.6 16.5 2.6.5 5.2 1 7.9 1 37.3 0 84.7-25 115.2-58.8z" />
    </svg>
  );
}
