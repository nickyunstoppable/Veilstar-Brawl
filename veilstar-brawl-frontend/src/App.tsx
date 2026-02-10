import { useState, useEffect } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { useWallet } from './hooks/useWallet';
import { VeilstarBrawlGame } from './games/veilstar-brawl/VeilstarBrawlGame';
import HomePage from './pages/HomePage';
import PlayPage from './pages/PlayPage';

const GAME_ID = 'veilstar-brawl';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Veilstar Brawl';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'ZK Fighting Game on Stellar';

function useSimpleRouter() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Intercept link clicks for SPA navigation
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:'))
        return;
      e.preventDefault();
      window.history.pushState({}, '', href);
      setPath(href);
      window.scrollTo({ top: 0 });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return path;
}

export default function App() {
  const path = useSimpleRouter();

  // Landing page (homepage)
  if (path === '/' || path === '') {
    return <HomePage />;
  }

  // Play / matchmaking page
  if (path === '/play') {
    return <PlayPage />;
  }

  // Game page
  return <GameView />;
}

function GameView() {
  const { publicKey, isConnected, isConnecting, error, isDevModeAvailable } = useWallet();
  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const devReady = isDevModeAvailable();

  return (
    <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
      {!hasContract ? (
        <div className="card">
          <h3 className="gradient-text">Contract Not Configured</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '1rem' }}>
            Run <code>bun run setup</code> to deploy and configure testnet contract IDs, or set
            <code>VITE_VEILSTAR_BRAWL_CONTRACT_ID</code> in the root <code>.env</code>.
          </p>
        </div>
      ) : !devReady ? (
        <div className="card">
          <h3 className="gradient-text">Dev Wallets Missing</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
            Run <code>bun run setup</code> to generate dev wallets for Player 1 and Player 2.
          </p>
        </div>
      ) : !isConnected ? (
        <div className="card">
          <h3 className="gradient-text">Connecting Dev Wallet</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
            The dev wallet switcher auto-connects Player 1. Use the switcher to toggle players.
          </p>
          {error && <div className="notice error" style={{ marginTop: '1rem' }}>{error}</div>}
          {isConnecting && <div className="notice info" style={{ marginTop: '1rem' }}>Connecting...</div>}
        </div>
      ) : (
        <VeilstarBrawlGame
          userAddress={userAddress}
          currentEpoch={1}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={() => {}}
        />
      )}
    </Layout>
  );
}
