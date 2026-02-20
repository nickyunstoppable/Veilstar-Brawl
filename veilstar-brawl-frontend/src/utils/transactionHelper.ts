/**
 * Transaction helper utilities
 */

import { contract } from '@stellar/stellar-sdk';

const RETRYABLE_TX_ERROR = /txBadSeq|TRY_AGAIN_LATER|temporar|timeout|network failed|Sending the transaction to the network failed/i;

const isNoSignatureNeededError = (err: unknown): boolean => {
  const errObj = err as any;
  const errName = errObj?.name ?? '';
  const errMessage = err instanceof Error ? err.message : String(err ?? '');
  return (
    errName.includes('NoSignatureNeededError') ||
    errMessage.includes('NoSignatureNeededError') ||
    errMessage.includes('This is a read call') ||
    errMessage.includes('requires no signature') ||
    errMessage.includes('force: true')
  );
};

const isRetryableTxError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return RETRYABLE_TX_ERROR.test(message);
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sign and send a transaction via Launchtube
 * @param tx - The assembled transaction or XDR string
 * @param timeoutInSeconds - Timeout for the transaction
 * @param validUntilLedgerSeq - Valid until ledger sequence
 * @returns Transaction result
 */
export async function signAndSendViaLaunchtube(
  tx: contract.AssembledTransaction<any> | string,
  timeoutInSeconds: number = 30,
  validUntilLedgerSeq?: number
): Promise<contract.SentTransaction<any>> {
  void timeoutInSeconds;
  void validUntilLedgerSeq;

  // If tx is an AssembledTransaction, simulate and send
  if (typeof tx !== 'string' && 'simulate' in tx) {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const simulated = await tx.simulate();
      try {
        return await simulated.signAndSend();
      } catch (err: unknown) {
        if (isNoSignatureNeededError(err)) {
          try {
            return await simulated.signAndSend({ force: true });
          } catch (forceErr: unknown) {
            if (isNoSignatureNeededError(forceErr)) {
              const simulatedResult =
                (simulated as any).result ??
                (simulated as any).simulationResult?.result ??
                (simulated as any).returnValue ??
                (tx as any).result;

              return {
                result: simulatedResult,
                getTransactionResponse: undefined,
              } as unknown as contract.SentTransaction<any>;
            }

            if (!isRetryableTxError(forceErr) || attempt >= maxAttempts) {
              throw forceErr;
            }

            lastError = forceErr;
            await delay(250 * attempt);
            continue;
          }
        }

        if (!isRetryableTxError(err) || attempt >= maxAttempts) {
          throw err;
        }

        lastError = err;
        await delay(250 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Transaction submission failed after retries');
  }

  // If tx is XDR string, it needs to be sent directly
  // This is typically used for multi-sig flows where the transaction is already built
  throw new Error('Direct XDR submission not yet implemented. Use AssembledTransaction.signAndSend() instead.');
}
