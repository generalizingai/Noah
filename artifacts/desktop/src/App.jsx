import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './services/auth';
import SignInScreen from './screens/SignInScreen';
import MainScreen from './screens/MainScreen';
import FloatingBar from './screens/FloatingBar';
import OnboardingScreen from './screens/OnboardingScreen';

// Detect if we are the floating bar window (Electron loads /floating-bar as pathname)
const isFloatingBarRoute = () =>
  window.location.pathname.includes('floating-bar') ||
  window.location.hash === '#/floating-bar' ||
  new URLSearchParams(window.location.search).get('route') === 'floating-bar';

// Logo: uses the PNG as a luminance mask so only the bright swirl is visible,
// regardless of what dark background the PNG has.
export function NoahLogo({ size = 32, className = '', pulse = false }) {
  return (
    <div
      className={`${pulse ? 'glow-pulse' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'block',
        // Tint colour of the icon — white-ish green matches the app palette
        background: 'rgba(228, 240, 232, 0.92)',
        // Luminance mask: bright pixels in the PNG → visible, dark pixels → transparent
        WebkitMaskImage: 'url(/noah-logo-transparent.png)',
        WebkitMaskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskMode: 'luminance',
        maskImage: 'url(/noah-logo-transparent.png)',
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskMode: 'luminance',
      }}
    />
  );
}

function AppInner() {
  const { user, loading }   = useAuth();
  const [route, setRoute]   = useState(isFloatingBarRoute() ? 'floating-bar' : 'main');
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    window.electronAPI?.onNavigate?.((r) => setRoute(r.replace('/', '')));
  }, []);

  // After sign-in, check if onboarding is done
  useEffect(() => {
    if (user && !loading) {
      const done = localStorage.getItem('noah_onboarding_done');
      if (!done) setShowOnboarding(true);
    }
  }, [user, loading]);

  if (route === 'floating-bar') return <FloatingBar />;

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-screen app-bg">
        <div className="flex flex-col items-center gap-5">
          <NoahLogo size={56} pulse />
          <div className="flex gap-1.5">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-green-500"
                style={{ animation: 'dot-bounce 1s ease-in-out infinite', animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!user) return <SignInScreen />;

  if (showOnboarding) {
    return <OnboardingScreen onComplete={() => setShowOnboarding(false)} />;
  }

  return <MainScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
