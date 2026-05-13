import { useState, useEffect } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { X } from 'lucide-react';

const PRODUCT_INFO = {
  name: 'Noah Device',
  price: '$69.99',
  url: 'https://apps.apple.com/us/app/friend-ai-wearable/id6502156163',
  shipping: 'Ships Worldwide',
  images: {
    primary: '/omi_1.webp',
    secondary: '/omi_2.webp',
  },
};

interface ProductBannerProps {
  variant?: 'detail' | 'floating' | 'category';
  className?: string;
  appName?: string;
  category?: string;
}

export function ProductBanner({
  variant = 'detail',
  className,
  appName,
}: ProductBannerProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDismissed, setIsDismissed] = useLocalStorage('product-banner-dismissed', false);
  const [isExiting, setIsExiting] = useState(false);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => {
      setIsDismissed(true);
    }, 300);
  };

  if (!isClient) return null;
  if (isDismissed && variant === 'floating') return null;

  if (variant === 'floating') {
    return (
      <div
        className={`fixed bottom-6 left-6 z-50 transition-all duration-300 ${
          isExiting ? 'translate-y-4 opacity-0' : 'translate-y-0 opacity-100'
        } ${className || ''}`}
      >
        <div
          className="group relative flex max-w-xs items-center gap-3 overflow-hidden rounded-2xl bg-gradient-to-r from-[#1A1F2E] to-[#141824] p-3 shadow-xl ring-1 ring-white/10"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <button
            onClick={handleDismiss}
            className="absolute right-2 top-2 text-gray-500 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>

          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[#1A1F2E] flex items-center justify-center">
            <img
              src={isHovered ? PRODUCT_INFO.images.secondary : PRODUCT_INFO.images.primary}
              alt={PRODUCT_INFO.name}
              className="h-full w-full object-cover transition-all duration-700"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>

          <div>
            <p className="text-xs font-semibold text-white">{PRODUCT_INFO.name}</p>
            <p className="text-xs text-gray-400">{PRODUCT_INFO.price} · {PRODUCT_INFO.shipping}</p>
            <a
              href={PRODUCT_INFO.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block rounded-full bg-[#6C8EEF] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[#5A7DE8]"
            >
              Get App
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#1A1F2E] to-[#141824] p-6 ${className || ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl ring-2 ring-white/10 bg-[#1A1F2E] flex items-center justify-center">
          <img
            src={isHovered ? PRODUCT_INFO.images.secondary : PRODUCT_INFO.images.primary}
            alt={PRODUCT_INFO.name}
            className="h-full w-full object-cover transition-all duration-700"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>

        <div className="flex-1">
          <h3 className="text-xl font-bold text-white">
            {appName ? `Experience ${appName} with ${PRODUCT_INFO.name}` : `Get ${PRODUCT_INFO.name}`}
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            AI-Powered Voice Assistant · {PRODUCT_INFO.price} · {PRODUCT_INFO.shipping}
          </p>
          <div className="mt-4 flex gap-3">
            <a
              href="https://apps.apple.com/us/app/friend-ai-wearable/id6502156163"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-xl bg-[#6C8EEF] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5A7DE8]"
            >
              App Store
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=com.friend.ios"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
            >
              Google Play
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
