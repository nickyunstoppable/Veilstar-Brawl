import { useState, useEffect, lazy, Suspense } from 'react';
import HomePage from './pages/HomePage';
import PlayPage from './pages/PlayPage';
import PracticePage from './pages/PracticePage';
import QueuePage from './pages/QueuePage';
import LeaderboardPage from './pages/LeaderboardPage';
import PlayerProfilePage from './pages/PlayerProfilePage';
import MatchPublicPage from './pages/MatchPublicPage';
import ReplayPage from './pages/ReplayPage';

// Lazy load the CharacterSelectClient for code splitting
const CharacterSelectClient = lazy(() =>
  import('./components/fight/CharacterSelectClient').then((mod) => ({
    default: mod.CharacterSelectClient,
  }))
);

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

/** Extract matchId from /m/:matchId (public match details) */
function extractPublicMatchId(path: string): string | null {
  const m = path.match(/^\/m\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** Extract matchId from /replay/:matchId */
function extractReplayMatchId(path: string): string | null {
  const m = path.match(/^\/replay\/([a-f0-9-]+)/i);
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

  // Public match details — /m/:matchId
  const publicMatchId = extractPublicMatchId(path);
  if (publicMatchId) {
    return <MatchPublicPage matchId={publicMatchId} />;
  }

  // Replay — /replay/:matchId
  const replayMatchId = extractReplayMatchId(path);
  if (replayMatchId) {
    return <ReplayPage matchId={replayMatchId} />;
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

  // 404 — page not found
  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-6 text-center px-4">
      <div className="text-8xl font-orbitron font-bold text-cyber-gold tracking-widest">404</div>
      <h1 className="text-2xl font-orbitron text-white tracking-wide">Page Not Found</h1>
      <p className="text-gray-400 max-w-sm">
        The page you're looking for doesn't exist or hasn't been built yet.
      </p>
      <a
        href="/"
        className="mt-2 px-6 py-3 rounded-lg bg-cyber-gold text-black font-orbitron font-bold text-sm tracking-widest hover:opacity-80 transition-opacity"
      >
        BACK TO HOME
      </a>
    </div>
  );
}
