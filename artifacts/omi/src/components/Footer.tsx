export default function Footer() {
  return (
    <footer className="w-full border-t border-solid border-zinc-800 bg-[#0B0F17] px-4 py-12 text-white md:px-12">
      <div className="mx-auto flex max-w-screen-xl flex-wrap justify-between gap-12">
        <div>
          <img
            src="/noah-logo.webp"
            alt="Noah Logo"
            className="h-auto w-[70px]"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <p className="mt-2 text-2xl font-bold text-white">Noah</p>
          <p className="mt-1 text-gray-500">AI Wearable Platform</p>
          <div className="mt-3 flex items-center gap-3">
            <a href="https://discord.com/invite/ZutWMTJnwA" target="_blank" rel="noopener noreferrer"
              className="text-gray-400 hover:text-white">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286z"/>
              </svg>
            </a>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Product</h3>
            <ul className="mt-4 space-y-2">
              <li><a href="/apps" className="text-sm text-gray-500 hover:text-white">App Store</a></li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Community</h3>
            <ul className="mt-4 space-y-2">
              <li><a href="https://discord.com/invite/ZutWMTJnwA" target="_blank" rel="noopener noreferrer"
                className="text-sm text-gray-500 hover:text-white">Discord</a></li>
            </ul>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-12 max-w-screen-xl border-t border-white/5 pt-8">
        <p className="text-sm text-gray-500">&copy; {new Date().getFullYear()} Noah. All rights reserved.</p>
      </div>
    </footer>
  );
}
