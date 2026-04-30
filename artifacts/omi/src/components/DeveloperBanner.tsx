import { Sparkles, ArrowRight } from 'lucide-react';
import { useState, useEffect } from 'react';

export const DeveloperBanner = () => {
  const [codeStep, setCodeStep] = useState(0);
  const codeLines = [
    'function createNoahApp() {',
    '  return {',
    '    name: "MyAwesomeApp",',
    '    type: "integration",',
    '    onConversation: (data) => {',
    '      // Your code here',
    '    }',
    '  };',
    '}',
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setCodeStep((prev) => (prev + 1) % codeLines.length);
    }, 1200);
    return () => clearInterval(interval);
  }, [codeLines.length]);

  return (
    <div className="container mx-auto px-3 sm:px-6 md:px-8">
      <div className="group block w-full transform transition-transform duration-300 hover:scale-[1.01]">
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-[#2D1B69] to-[#6C2BD9] shadow-lg">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/20"></div>
            <div className="absolute -bottom-8 -left-8 h-40 w-40 rounded-full bg-white/20"></div>
            <div className="absolute bottom-12 right-12 h-24 w-24 rounded-full bg-white/20"></div>
          </div>

          <div className="absolute right-4 top-4 animate-pulse">
            <Sparkles className="h-5 w-5 text-purple-200/70" />
          </div>

          <div className="relative z-10 flex h-auto flex-col p-6 sm:h-[12rem] sm:flex-row sm:items-center sm:justify-between sm:p-8 md:p-10">
            <div className="flex flex-col sm:max-w-xs md:max-w-sm">
              <div className="mb-3 flex items-center gap-2">
                <img
                  src="/omi-white.webp"
                  alt="Omi"
                  className="h-6 w-auto object-contain"
                />
                <span className="text-xs font-bold uppercase tracking-widest text-purple-300">
                  For Developers
                </span>
              </div>
              <h3 className="text-xl font-bold text-white sm:text-2xl">
                Build Your Own Omi App
              </h3>
              <p className="mt-2 text-sm text-purple-200 sm:text-base">
                Create apps that integrate with conversations, memories, and real-time AI
              </p>
            </div>

            <div className="mt-6 hidden w-full max-w-xs rounded-lg bg-black/30 p-4 font-mono text-xs text-green-400 sm:mt-0 sm:block">
              {codeLines.map((line, idx) => (
                <div
                  key={idx}
                  className={`transition-opacity duration-300 ${
                    idx <= codeStep ? 'opacity-100' : 'opacity-20'
                  }`}
                >
                  {line}
                </div>
              ))}
            </div>

            <div className="mt-6 flex sm:mt-0 sm:ml-6">
              <div className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition-all group-hover:bg-white/20">
                Start Building
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
