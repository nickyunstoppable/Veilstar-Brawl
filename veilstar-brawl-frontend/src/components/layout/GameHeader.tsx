import { useState } from 'react';
import { LogOut } from 'lucide-react';

export function GameHeader() {
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);

  // Placeholder wallet state — will be wired to real backend later
  const isConnected = false;
  const isConnecting = false;
  const truncatedAddress = '';
  const balance = '0';

  const handleConnect = () => {
    // TODO: integrate wallet connection
    setIsWalletModalOpen(false);
  };

  const handleDisconnect = () => {
    // TODO: integrate wallet disconnection
  };

  return (
    <div className="w-full flex justify-end items-center gap-4 p-4 lg:p-6 bg-transparent z-20 relative">
      {isConnected && truncatedAddress ? (
        <div className="flex items-center gap-2">
          {/* Main Pill Container */}
          <div className="flex items-center bg-black/80 border border-cyber-gold/50 rounded-full h-10 p-1 pl-1 backdrop-blur-md relative group hover:border-cyber-gold transition-colors">
            {/* Inner Balance Pill */}
            <div className="flex items-center bg-cyber-gold/10 rounded-full h-8 px-4 border border-cyber-gold/20 mr-3">
              <span className="font-orbitron font-bold text-cyber-gold text-lg tracking-widest drop-shadow-[0_0_5px_rgba(240,183,31,0.5)]">
                {balance}
              </span>
              <span className="text-[10px] text-cyber-gold/70 font-orbitron ml-1 mt-1">
                XLM
              </span>
            </div>

            {/* Address */}
            <div className="font-mono text-white text-sm tracking-wide mr-3 font-medium opacity-90 hover:text-cyber-gold transition-colors cursor-pointer">
              {truncatedAddress}
            </div>

            {/* Disconnect Icon */}
            <button
              onClick={handleDisconnect}
              className="text-gray-400 hover:text-white hover:bg-white/10 h-8 w-8 rounded-full flex items-center justify-center bg-transparent border-none p-0"
              title="Disconnect"
            >
              <LogOut className="w-4 h-4 ml-0.5" />
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsWalletModalOpen(true)}
          disabled={isConnecting}
          className="bg-gradient-cyber text-white border-0 font-bold font-orbitron shadow-[0_0_20px_rgba(240,183,31,0.2)] hover:shadow-[0_0_30px_rgba(240,183,31,0.4)] transition-all duration-300 px-6 py-2 rounded-xl text-sm"
        >
          {isConnecting ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Connecting...
            </span>
          ) : (
            'Connect Wallet'
          )}
        </button>
      )}
    </div>
  );
}
