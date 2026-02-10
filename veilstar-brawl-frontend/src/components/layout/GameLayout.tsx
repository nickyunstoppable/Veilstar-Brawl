import { ReactNode } from 'react';
import { GameSidebar } from './GameSidebar';
import { GameHeader } from './GameHeader';

interface GameLayoutProps {
  children: ReactNode;
}

export default function GameLayout({ children }: GameLayoutProps) {
  return (
    <div className="fixed inset-0 w-screen h-screen overflow-hidden bg-cyber-black text-white font-montserrat flex">
      {/* Background Effects */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute inset-0 bg-[url('/assets/hero.webp')] bg-[length:80%_auto] bg-no-repeat bg-center opacity-10" />
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple-900/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] bg-cyber-gold/5 rounded-full blur-[100px]" />
        <div className="absolute inset-0 bg-[url('/assets/grid.svg')] opacity-[0.03]" />
      </div>

      {/* Sidebar */}
      <GameSidebar />

      {/* Main Content Area */}
      <main className="flex-1 relative z-10 flex flex-col min-w-0 overflow-hidden lg:pl-0 lg:pt-0 transition-all duration-300">
        <GameHeader />
        <div className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto overflow-x-hidden">
          {children}
        </div>
      </main>
    </div>
  );
}
