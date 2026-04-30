import { Star, Download } from 'lucide-react';
import { Link } from 'wouter';
import { Plugin, PluginStat } from '@/types/plugin';
import { NewBadge } from './NewBadge';

export interface CompactPluginCardProps {
  plugin: Plugin;
  stat?: PluginStat;
  index: number;
}

const formatInstalls = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

export function CompactPluginCard({ plugin, index }: CompactPluginCardProps) {
  return (
    <Link
      href={`/apps/${plugin.id}`}
      className="group flex items-start gap-2.5 rounded-lg p-2 text-left transition-colors duration-300 hover:bg-[#1A1F2E]/50"
    >
      <span className="flex w-4 shrink-0 items-center text-sm font-medium text-gray-400">
        {index}
      </span>

      <img
        src={plugin.image || 'https://via.placeholder.com/40'}
        alt={plugin.name}
        className="h-11 w-11 shrink-0 rounded-lg object-cover sm:h-14 sm:w-14"
        width={56}
        height={56}
        onError={(e) => {
          (e.target as HTMLImageElement).src = 'https://via.placeholder.com/56';
        }}
      />

      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 truncate font-medium text-white transition-colors group-hover:text-[#6C8EEF]">
            {plugin.name}
          </h3>
          <NewBadge plugin={plugin} />
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-gray-400">by {plugin.author}</span>
          <div className="flex shrink-0 items-center gap-2.5 text-xs text-gray-400">
            <div className="flex items-center">
              <Star className="mr-1 h-3.5 w-3.5" />
              <span>{plugin.rating_avg?.toFixed(1)}</span>
            </div>
            <div className="flex items-center">
              <Download className="mr-1 h-3 w-3" />
              <span>{formatInstalls(plugin.installs)}</span>
            </div>
          </div>
        </div>

        <p className="line-clamp-1 text-xs text-gray-400 transition-colors group-hover:text-gray-300 sm:text-sm">
          {plugin.description}
        </p>
      </div>
    </Link>
  );
}
