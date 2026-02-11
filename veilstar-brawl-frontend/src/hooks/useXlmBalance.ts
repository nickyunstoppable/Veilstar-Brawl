import { useEffect, useState } from 'react';
import { NETWORK } from '../utils/constants';

interface BalanceState {
  balance: string;
  loading: boolean;
  error: string | null;
}

async function fetchXlmBalance(address: string): Promise<string> {
  const horizonUrl =
    NETWORK === 'testnet'
      ? 'https://horizon-testnet.stellar.org'
      : NETWORK === 'mainnet'
      ? 'https://horizon.stellar.org'
      : null;

  if (!horizonUrl || !address) return '0';

  try {
    const res = await fetch(`${horizonUrl}/accounts/${address}`, { method: 'GET' });
    
    if (res.status === 404) {
      return '0';
    }
    
    if (!res.ok) {
      throw new Error(`Horizon error ${res.status}`);
    }

    const data = await res.json();
    const xlmBalance = data.balances?.find(
      (b: { asset_type: string }) => b.asset_type === 'native'
    );

    return xlmBalance?.balance || '0';
  } catch (error) {
    console.error('Failed to fetch XLM balance:', error);
    return '0';
  }
}

export function useXlmBalance(address: string | null | undefined) {
  const [state, setState] = useState<BalanceState>({
    balance: '0',
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!address || typeof address !== 'string') {
      setState({ balance: '0', loading: false, error: null });
      return;
    }

    let mounted = true;

    const loadBalance = async () => {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const balance = await fetchXlmBalance(address);
        if (mounted) {
          setState({ balance, loading: false, error: null });
        }
      } catch (error) {
        if (mounted) {
          const message = error instanceof Error ? error.message : 'Failed to fetch balance';
          setState({ balance: '0', loading: false, error: message });
        }
      }
    };

    loadBalance();

    // Refresh balance every 30 seconds
    const interval = setInterval(loadBalance, 30000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [address]);

  return state;
}
