import { useState, useEffect } from 'react';
import { useParams, Link } from 'wouter';
import { ChevronUp } from 'lucide-react';
import { Plugin } from '@/types/plugin';
import { CompactPluginCard } from '@/components/CompactPluginCard';
import { FeaturedPluginCard } from '@/components/FeaturedPluginCard';
import { CategoryHeader } from '@/components/CategoryHeader';
import { ScrollableCategoryNav } from '@/components/ScrollableCategoryNav';
import { SearchBar } from '@/components/SearchBar';
import { getApprovedApps } from '@/lib/api';

function seededShuffle<T>(array: T[], seed: number): T[] {
  const shuffled = [...array];
  const random = (i: number) => {
    const x = Math.sin(i + seed) * 10000;
    return x - Math.floor(x);
  };
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random(i) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export default function CategoryPage() {
  const params = useParams<{ category: string }>();
  const [allPlugins, setAllPlugins] = useState<Plugin[]>([]);
  const [categoryPlugins, setCategoryPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (!params.category) return;

    setLoading(true);
    getApprovedApps()
      .then((data) => {
        setAllPlugins(data);
        const category = params.category;
        const filtered = category === 'integration'
          ? data.filter((p) => p.capabilities.has('external_integration'))
          : data.filter((p) => p.category === category);

        setCategoryPlugins(filtered);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [params.category]);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  const newOrRecentApps = seededShuffle(
    [...categoryPlugins].sort((a, b) => a.installs - b.installs).slice(0, 4),
    Date.now() % 1000
  );

  const mostPopular = categoryPlugins.length > 6
    ? [...categoryPlugins].sort((a, b) => b.installs - a.installs).slice(0, 6)
    : [];

  const allApps = [...categoryPlugins].sort((a, b) => b.installs - a.installs);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F17]">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#6C8EEF] border-t-transparent"></div>
          <p className="mt-4 text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[#0B0F17]">
      {/* Fixed Header */}
      <div className="fixed inset-x-0 top-12 z-40 bg-[#0B0F17]">
        <div className="border-b border-white/5">
          <div className="container mx-auto px-3 py-3 sm:px-6 sm:py-4 md:px-8 md:py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="shrink-0">
                <CategoryHeader category={params.category || ''} totalApps={categoryPlugins.length} />
              </div>
              <div className="flex-grow">
                <SearchBar
                  allApps={allPlugins}
                  onSearching={(searching) => setIsSearching(searching)}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="border-b border-white/5 bg-[#0B0F17]/80 backdrop-blur-sm">
          <div className="container mx-auto px-3 sm:px-6 md:px-8">
            <div className="py-2.5">
              <ScrollableCategoryNav currentCategory={params.category || ''} />
            </div>
          </div>
        </div>
      </div>

      {!isSearching && (
        <main className="relative z-0 mt-[14rem] sm:mt-[15rem] md:mt-[16rem] pb-16">
          <div className="container mx-auto px-3 py-2 sm:px-6 sm:py-4 md:px-8 md:py-6">
            {categoryPlugins.length === 0 ? (
              <div className="mt-16 text-center">
                <p className="text-gray-400">No apps found in this category.</p>
                <Link href="/apps" className="mt-4 inline-block text-[#6C8EEF] hover:underline">
                  Browse all apps
                </Link>
              </div>
            ) : (
              <div className="space-y-6 sm:space-y-8 md:space-y-10">
                {/* New / Recently Added */}
                {newOrRecentApps.length > 0 && (
                  <section className="pt-4 sm:pt-6 md:pt-8">
                    <h3 className="mb-3 text-sm font-semibold text-white sm:mb-4 sm:text-base md:mb-5 md:text-lg">
                      {newOrRecentApps.some((p) => p.installs === 0)
                        ? 'New This Week'
                        : 'Recently Added'}
                    </h3>
                    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4 lg:gap-4">
                      {newOrRecentApps.map((plugin) => (
                        <FeaturedPluginCard key={plugin.id} plugin={plugin} />
                      ))}
                    </div>
                  </section>
                )}

                {/* Most Popular */}
                {mostPopular.length > 0 && (
                  <section>
                    <h3 className="mb-3 text-sm font-semibold text-white sm:mb-4 sm:text-base md:mb-5 md:text-lg">
                      Most Popular
                    </h3>
                    <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 lg:gap-4">
                      {mostPopular.map((plugin, index) => (
                        <CompactPluginCard key={plugin.id} plugin={plugin} index={index + 1} />
                      ))}
                    </div>
                  </section>
                )}

                {/* All Apps */}
                <section>
                  <h3 className="mb-3 text-sm font-semibold text-white sm:mb-4 sm:text-base md:mb-5 md:text-lg">
                    All Apps
                  </h3>
                  <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 lg:gap-4">
                    {allApps.map((plugin, index) => (
                      <CompactPluginCard key={plugin.id} plugin={plugin} index={index + 1} />
                    ))}
                  </div>
                </section>
              </div>
            )}
          </div>

          <button
            onClick={scrollToTop}
            className="fixed bottom-6 right-6 z-50 flex h-10 w-10 items-center justify-center rounded-full bg-[#6C8EEF] text-white shadow-lg transition-all duration-300 hover:bg-[#5A7DD9]"
            aria-label="Back to top"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
        </main>
      )}
    </div>
  );
}
