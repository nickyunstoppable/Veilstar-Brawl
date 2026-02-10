import { ReactNode } from 'react';
import LandingHeader from './LandingHeader';

interface LandingLayoutProps {
  children: ReactNode;
}

export default function LandingLayout({ children }: LandingLayoutProps) {
  return (
    <div className="h-screen overflow-y-auto bg-[#010101] text-white font-['Montserrat']">
      {/* Header */}
      <LandingHeader />

      {/* Main Content */}
      <main>{children}</main>

      {/* Footer */}
      <footer className="relative mt-20 border-t border-[#7B2FBE]/20">
        <div className="container mx-auto px-6 lg:px-12 xl:px-24 py-12">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img
                  src="/logo.webp"
                  alt="Veilstar Brawl Logo"
                  className="w-8 h-8 object-contain"
                />
                <h3
                  className="text-xl font-bold font-['Orbitron'] bg-clip-text text-transparent"
                  style={{ backgroundImage: 'linear-gradient(90deg, #F0B71F, #E03609)' }}
                >
                  Veilstar Brawl
                </h3>
              </div>
              <p className="text-[#999] text-sm">
                A ZK-powered fighting game on the Stellar blockchain. Provable moves, hidden strategies, real stakes.
              </p>
            </div>

            {/* Resources */}
            <div>
              <h4 className="text-white font-semibold mb-4 font-['Orbitron']">Resources</h4>
              <ul className="space-y-2 text-[#999] text-sm">
                <li>
                  <a href="#faq" className="hover:text-[#F0B71F] transition-colors">
                    FAQ
                  </a>
                </li>
                <li>
                  <a href="#features" className="hover:text-[#F0B71F] transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <a
                    href="https://stellar.org"
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-[#F0B71F] transition-colors"
                  >
                    Stellar Network
                  </a>
                </li>
              </ul>
            </div>

            {/* Game */}
            <div>
              <h4 className="text-white font-semibold mb-4 font-['Orbitron']">Game</h4>
              <ul className="space-y-2 text-[#999] text-sm">
                <li>
                  <a href="/play" className="hover:text-[#F0B71F] transition-colors">
                    Play
                  </a>
                </li>
                <li>
                  <a href="#zk" className="hover:text-[#F0B71F] transition-colors">
                    ZK Mechanics
                  </a>
                </li>
              </ul>
            </div>

            {/* Community */}
            <div>
              <h4 className="text-white font-semibold mb-4 font-['Orbitron']">Community</h4>
              <ul className="space-y-2 text-[#999] text-sm">
                <li>
                  <a href="#" className="hover:text-[#F0B71F] transition-colors">
                    Discord
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-[#F0B71F] transition-colors">
                    Twitter
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-[#F0B71F] transition-colors">
                    Telegram
                  </a>
                </li>
              </ul>
            </div>
          </div>

          {/* Bottom */}
          <div className="pt-8 border-t border-[#7B2FBE]/20 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex gap-6 text-sm text-[#999]">
              <span>&copy; 2026 Veilstar Brawl. All rights reserved.</span>
            </div>

            {/* Social Icons */}
            <div className="flex gap-4">
              <a
                href="#"
                className="w-8 h-8 rounded-full bg-[#F0B71F]/10 flex items-center justify-center hover:bg-[#F0B71F]/20 transition-colors"
              >
                <span className="sr-only">Twitter</span>
                <svg className="w-4 h-4 text-[#F0B71F]" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
                </svg>
              </a>
              <a
                href="#"
                className="w-8 h-8 rounded-full bg-[#F0B71F]/10 flex items-center justify-center hover:bg-[#F0B71F]/20 transition-colors"
              >
                <span className="sr-only">GitHub</span>
                <svg className="w-4 h-4 text-[#F0B71F]" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
