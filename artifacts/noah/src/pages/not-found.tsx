import { Link } from 'wouter';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0B0F17] text-white">
      <h1 className="text-6xl font-bold text-[#6C8EEF]">404</h1>
      <p className="mt-4 text-xl text-gray-400">Page not found</p>
      <Link href="/apps" className="mt-8 rounded-xl bg-[#6C8EEF] px-6 py-3 text-sm font-medium text-white hover:bg-[#5A7DE8]">
        Browse Apps
      </Link>
    </div>
  );
}
