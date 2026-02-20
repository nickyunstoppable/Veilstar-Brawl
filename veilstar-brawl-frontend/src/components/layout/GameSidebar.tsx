import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import {
  Gamepad2,
  Trophy,
  Eye,
  Menu,
  X,
} from 'lucide-react';

const NAV_ITEMS = [
  {
    label: 'Play',
    href: '/play',
    icon: Gamepad2,
    color: 'text-cyber-gold',
  },
  {
    label: 'Leaderboard',
    href: '/leaderboard',
    icon: Trophy,
    color: 'text-cyber-orange',
  },
  {
    label: 'Watch',
    href: '/spectate',
    icon: Eye,
    color: 'text-purple-400',
  },
];

export function GameSidebar() {
  const pathname = window.location.pathname;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <>
      {/* Mobile Menu Button */}
      <div
        className={cn(
          'lg:hidden fixed top-4 left-4 z-50 transition-opacity duration-300',
          isMobileMenuOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
      >
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="bg-cyber-black/80 backdrop-blur-md border border-white/10 text-white p-2 rounded-lg"
        >
          <Menu className="w-6 h-6" />
        </button>
      </div>

      {/* Sidebar Container */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-72 bg-cyber-black/95 backdrop-blur-xl border-r border-white/10 flex flex-col transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static',
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo Area */}
        <div className="p-6 border-b border-white/5 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 group">
            <img
              src="/logo.webp"
              alt="Veilstar Brawl"
              className="w-10 h-10 object-contain group-hover:scale-110 transition-transform duration-300"
            />
            <div className="flex flex-col">
              <span className="text-xl font-bold font-orbitron text-white leading-none">
                VEILSTAR
              </span>
              <span className="text-xl font-bold font-orbitron bg-gradient-cyber bg-clip-text text-transparent leading-none">
                BRAWL
              </span>
            </div>
          </a>
          <button
            className="lg:hidden text-cyber-gray hover:text-white bg-transparent border-none p-1"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <div className="flex-1 py-6 px-4 space-y-2 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setIsMobileMenuOpen(false)}
                className={cn(
                  'relative flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 group overflow-hidden no-underline',
                  isActive
                    ? 'bg-white/5 text-white shadow-[0_0_20px_rgba(240,183,31,0.1)] border border-white/10'
                    : 'text-cyber-gray hover:text-white hover:bg-white/5 border border-transparent'
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="sidebar-active"
                    className="absolute inset-0 bg-gradient-to-r from-cyber-gold/10 to-transparent opacity-50"
                    initial={false}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  />
                )}

                <Icon
                  className={cn(
                    'w-5 h-5 transition-colors duration-300 relative z-10',
                    isActive ? item.color : 'text-cyber-gray group-hover:text-white'
                  )}
                />
                <span
                  className={cn(
                    'font-medium relative z-10 font-orbitron tracking-wide text-sm',
                    isActive ? 'text-white' : ''
                  )}
                >
                  {item.label}
                </span>

                {isActive && (
                  <div className="absolute right-2 w-1.5 h-1.5 rounded-full bg-cyber-gold shadow-[0_0_10px_#F0B71F]" />
                )}
              </a>
            );
          })}
        </div>
      </aside>

      {/* Backdrop for mobile */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsMobileMenuOpen(false)}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-30 lg:hidden"
          />
        )}
      </AnimatePresence>
    </>
  );
}
