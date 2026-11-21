/** Pending-nonce cursor. The chain is asked once, then this process hands out the next nonce. */
export class NonceBook {
  private next: number | null = null;

  async take(fetchPending: () => Promise<number>): Promise<number> {
    if (this.next === null) {
      const pending = await fetchPending();
      if (!Number.isInteger(pending) || pending < 0) {
        throw new Error("Pending nonce was not a usable number.");
      }
      this.next = pending;
    }
    const nonce = this.next;
    this.next += 1;
    return nonce;
  }

  reset(): void {
    this.next = null;
  }
}

export function bufferedGas(estimated: bigint, floor: bigint): bigint {
  if (estimated <= 0n) throw new Error("Gas estimate was not positive. The transaction was not sent.");
  const buffered = (estimated * 12n) / 10n + 10000n;
  return buffered > floor ? buffered : floor;
}
