import { useState, useEffect } from 'react';
import { useParams, Link } from 'wouter';
import { Calendar, User, FolderOpen, Puzzle, ArrowRight, DollarSign, Star } from 'lucide-react';
import { Plugin } from '@/types/plugin';
import { CompactPluginCard } from '@/components/CompactPluginCard';
import { ScrollableCategoryNav } from '@/components/ScrollableCategoryNav';
import { ProductBanner } from '@/components/ProductBanner';
import { getAppById, getAppsByCategory } from '@/lib/api';
import { getCategoryIcon, getCategoryMetadata } from '@/utils/category';
import { ChevronRight } from 'lucide-react';

const formatInstalls = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

const formatDate = (dateString: string | null | undefined): string | null => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime()) || date.getTime() === 0) return null;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

const formatCategoryName = (category: string): string => {
  return category
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export default function AppDetailPage() {
  const params = useParams<{ id: string }>();
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [relatedApps, setRelatedApps] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;

    setLoading(true);
    getAppById(params.id)
      .then(async (app) => {
        if (!app) {
          setError('App not found');
          setLoading(false);
          return;
        }
        setPlugin(app);

        const related = await getAppsByCategory(app.category);
        setRelatedApps(related.filter((p) => p.id !== app.id).slice(0, 6));
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load app');
        setLoading(false);
      });
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F17]">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#6C8EEF] border-t-transparent"></div>
          <p className="mt-4 text-gray-400">Loading app...</p>
        </div>
      </div>
    );
  }

  if (error || !plugin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F17]">
        <div className="text-center">
          <p className="text-xl text-white">App not found</p>
          <Link href="/apps" className="mt-4 inline-block text-[#6C8EEF] hover:underline">
            Back to Apps
          </Link>
        </div>
      </div>
    );
  }

  const categoryName = formatCategoryName(plugin.category);
  const CategoryIcon = getCategoryIcon(plugin.category);
  const categoryMeta = getCategoryMetadata(plugin.category);

  return (
    <div className="relative flex min-h-screen flex-col bg-[#0B0F17]">
      {/* Fixed Header */}
      <div className="fixed inset-x-0 top-[3rem] z-50 bg-[#0B0F17]">
        <div className="border-b border-white/5 shadow-lg">
          <div className="container mx-auto px-6 py-4">
            <nav className="flex items-center space-x-2 text-sm text-gray-400">
              <Link href="/apps" className="text-[#6C8EEF] transition-colors hover:text-[#5A7DE8]">
                Apps
              </Link>
              <ChevronRight className="h-4 w-4" />
              <Link
                href={`/apps/category/${plugin.category}`}
                className="flex items-center transition-colors hover:text-white"
              >
                <CategoryIcon className="mr-1.5 h-4 w-4" />
                <span className={categoryMeta.theme.secondary}>{categoryMeta.displayName}</span>
              </Link>
              <ChevronRight className="h-4 w-4" />
              <span className="truncate text-gray-300 max-w-[200px]">{plugin.name}</span>
            </nav>
          </div>
        </div>
        <div className="border-b border-white/5 bg-[#0B0F17]/80 backdrop-blur-sm">
          <div className="container mx-auto px-6">
            <div className="py-2.5">
              <ScrollableCategoryNav currentCategory={plugin.category} />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="relative z-0 mt-[10rem] flex-grow">
        <div className="container mx-auto px-6 pt-8">
          {/* Hero Section */}
          <section className="grid grid-cols-1 gap-12 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <div className="relative aspect-square overflow-hidden rounded-[1rem] bg-[#1A1F2E]">
                <img
                  src={plugin.image}
                  alt={plugin.name}
                  className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = 'https://via.placeholder.com/500';
                  }}
                />
              </div>
            </div>

            <div className="lg:col-span-3">
              <div className="flex h-full flex-col justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-4xl font-bold text-white">{plugin.name}</h1>
                    {plugin.is_paid && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-sm font-semibold text-amber-400">
                        <DollarSign className="h-4 w-4" />
                        {plugin.price?.toFixed(2)}
                        {plugin.payment_plan === 'monthly_recurring' ? '/mo' : ''}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xl text-gray-400">by {plugin.author}</p>

                  <div className="mt-8 flex items-center gap-4">
                    <div className="flex items-center">
                      <span className="text-3xl font-bold text-yellow-400">
                        {plugin.rating_avg?.toFixed(1)}
                      </span>
                      <div className="ml-2 flex flex-col">
                        <Star className="h-4 w-4 text-yellow-400" />
                        <span className="text-sm text-gray-400">
                          ({plugin.rating_count} reviews)
                        </span>
                      </div>
                    </div>
                    <div className="h-8 w-px bg-white/5" />
                    <div className="flex items-center">
                      <span className="text-3xl font-bold text-[#6C8EEF]">
                        {formatInstalls(plugin.installs)}
                      </span>
                      <span className="ml-2 text-sm text-gray-400">downloads</span>
                    </div>
                  </div>

                  <div className="mt-8">
                    <a
                      href="https://apps.apple.com/us/app/friend-ai-wearable/id6502156163"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-center justify-center overflow-hidden rounded-xl bg-[#6C8EEF] px-6 py-3 text-base font-medium text-white transition-all hover:bg-[#5A7DE8]"
                    >
                      Try it now
                      <ArrowRight className="ml-2 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                    </a>

                    <div className="mt-4 flex items-center gap-4">
                      <a
                        href="https://apps.apple.com/us/app/friend-ai-wearable/id6502156163"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-transform duration-300 hover:scale-105"
                      >
                        <img
                          src="/app-store-badge.svg"
                          alt="Download on the App Store"
                          className="h-[40px]"
                        />
                      </a>
                      <a
                        href="https://play.google.com/store/apps/details?id=com.friend.ios"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-transform duration-300 hover:scale-105"
                      >
                        <img
                          src="/google-play-badge.png"
                          alt="Get it on Google Play"
                          className="h-[40px]"
                        />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Product Banner */}
          <section className="mt-12">
            <ProductBanner variant="detail" appName={plugin.name} />
          </section>

          {/* About Section */}
          <section className="mt-16">
            <h2 className="text-2xl font-bold text-white">About</h2>
            <div className="mt-4">
              <p className="text-lg leading-relaxed text-gray-300">{plugin.description}</p>
            </div>
          </section>

          {/* Additional Details */}
          <section className="mt-16">
            <h2 className="mb-6 text-2xl font-bold text-white">Additional Details</h2>
            <div className="grid gap-8 sm:grid-cols-2">
              {plugin.is_paid && (
                <div>
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-amber-400" />
                    <div className="text-sm font-medium text-gray-400">Pricing</div>
                  </div>
                  <div className="mt-1 pl-7">
                    <span className="text-base font-semibold text-amber-400">
                      ${plugin.price?.toFixed(2)}
                      {plugin.payment_plan === 'monthly_recurring' ? '/month' : ''}
                    </span>
                    <span className="ml-2 text-sm text-gray-400">
                      {plugin.payment_plan === 'monthly_recurring'
                        ? '(Monthly subscription)'
                        : plugin.payment_plan === 'one_time'
                          ? '(One-time purchase)'
                          : '(Paid)'}
                    </span>
                  </div>
                </div>
              )}
              {formatDate(plugin.created_at) && (
              <div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-gray-400" />
                  <div className="text-sm font-medium text-gray-400">Created</div>
                </div>
                <div className="mt-1 pl-7 text-base text-white">
                  {formatDate(plugin.created_at)}
                </div>
              </div>
              )}
              <div>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-gray-400" />
                  <div className="text-sm font-medium text-gray-400">Creator</div>
                </div>
                <div className="mt-1 pl-7 text-base text-white">{plugin.author}</div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <div className="text-sm font-medium text-gray-400">Category</div>
                </div>
                <div className="mt-1 pl-7 text-base text-white">{categoryName}</div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Puzzle className="h-5 w-5 text-gray-400" />
                  <div className="text-sm font-medium text-gray-400">Capabilities</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 pl-7">
                  {Array.from(plugin.capabilities).map((cap) => (
                    <span
                      key={cap}
                      className="rounded-full bg-[#1A1F2E] px-3 py-1 text-sm text-white"
                    >
                      {cap.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Related Apps */}
          {relatedApps.length > 0 && (
            <section className="mt-16 pb-12">
              <h2 className="mb-8 text-2xl font-bold text-white">
                More {categoryName} Apps
              </h2>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {relatedApps.map((app, index) => (
                  <CompactPluginCard key={app.id} plugin={app} index={index + 1} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
