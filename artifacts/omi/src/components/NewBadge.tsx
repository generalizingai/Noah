import { Plugin } from '@/types/plugin';

export function isNewApp(plugin: Plugin): boolean {
  if (!plugin.created_at) return false;
  try {
    const creationDate = new Date(plugin.created_at);
    const now = new Date();
    if (isNaN(creationDate.getTime())) return false;
    const diffInDays = Math.floor(
      (now.getTime() - creationDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    return diffInDays <= 7;
  } catch {
    return false;
  }
}

interface NewBadgeProps {
  plugin: Plugin;
  className?: string;
}

export function NewBadge({ plugin, className = '' }: NewBadgeProps) {
  if (!isNewApp(plugin)) return null;

  return (
    <span
      className={`shrink-0 rounded-full bg-[#6C8EEF]/10 px-2 py-0.5 text-xs font-medium text-[#6C8EEF] ${className}`}
    >
      NEW
    </span>
  );
}
