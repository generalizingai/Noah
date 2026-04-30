import { Link, useLocation } from 'wouter';
import { useState, useEffect } from 'react';

export function AppHeader() {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0B0F17]/95 backdrop-blur-lg">
      <div className="container mx-auto flex h-12 items-center justify-between px-4">
        <Link href="/apps" className="flex items-center gap-2">
          <img
            src="/noah-logo.webp"
            alt="Noah"
            className="h-7 w-auto"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <span className="text-sm font-semibold text-white">Noah</span>
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          <Link
            href="/apps"
            className="text-sm text-gray-400 transition-colors hover:text-white"
          >
            Apps
          </Link>
          <a
            href="https://discord.com/invite/ZutWMTJnwA"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-400 transition-colors hover:text-white"
          >
            Discord
          </a>
          <Link
            href="/download"
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </Link>
        </nav>

        <button
          className="flex sm:hidden items-center text-gray-400 hover:text-white"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          <span className="sr-only">Menu</span>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d={mobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
          </svg>
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="border-t border-white/5 bg-[#0B0F17] px-4 py-4 sm:hidden">
          <nav className="flex flex-col gap-3">
            <Link href="/apps" className="text-sm text-gray-400 hover:text-white">Apps</Link>
            <a href="https://discord.com/invite/ZutWMTJnwA" target="_blank" rel="noopener noreferrer"
              className="text-sm text-gray-400 hover:text-white">Discord</a>
            <Link href="/download" className="text-sm font-medium text-white hover:text-gray-200">
              Download for Mac
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
