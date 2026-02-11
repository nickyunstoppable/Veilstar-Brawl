import { useState, useEffect, lazy, Suspense } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { useWallet } from './hooks/useWallet';
import { VeilstarBrawlGame } from './games/veilstar-brawl/VeilstarBrawlGame';
import HomePage from './pages/HomePage';
import PlayPage from './pages/PlayPage';
import PracticePage from './pages/PracticePage';
import QueuePage from './pages/QueuePage';
import LeaderboardPage from './pages/LeaderboardPage';
import PlayerProfilePage from './pages/PlayerProfilePage';

// Lazy load the CharacterSelectClient for code splitting
const CharacterSelectClient = lazy(() =>
  import('./components/fight/CharacterSelectClient').then((mod) => ({
    default: mod.CharacterSelectClient,
  }))
);

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

/** Extract matchId from /match/:matchId */
function extractMatchId(path: string): string | null {
  const m = path.match(/^\/match\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** Extract address from /player/:address */
function extractPlayerAddress(path: string): string | null {
  const m = path.match(/^\/player\/([A-Z0-9]+)$/);
  return m ? m[1] : null;
}

export default function App() {
  const path = useSimpleRouter();

  // Landing page (homepage)
  if (path === '/' || path === '') {
    return <HomePage />;
  }

  // Play / arena lobby
  if (path === '/play') {
    return <PlayPage />;
  }

  // Practice mode
  if (path === '/practice') {
    return <PracticePage />;
  }

  // Matchmaking queue (immersive HUD)
  if (path === '/queue') {
    return <QueuePage />;
  }

  // Leaderboard
  if (path === '/leaderboard') {
    return <LeaderboardPage />;
  }

  // Player profile — /player/:address
  const playerAddress = extractPlayerAddress(path);
  if (playerAddress) {
    return <PlayerProfilePage address={playerAddress} />;
  }

  // Match route — /match/:matchId → CharacterSelectScene → FightScene
  const matchId = extractMatchId(path);
  if (matchId) {
    return (
      <Suspense
        fallback={
          <div className="fixed inset-0 bg-black flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-cyber-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-cyber-gold font-orbitron tracking-widest text-sm">LOADING...</p>
            </div>
          </div>
        }
      >
        <CharacterSelectClient matchId={matchId} />
      </Suspense>
    );
  }

  // Legacy /match route (no matchId) — redirect to queue
  if (path === '/match') {
    return <QueuePage />;
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
          onStandingsRefresh={() => { }}
          onGameComplete={() => { }}
        />
      )}
    </Layout>
  );
}
