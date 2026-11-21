import { keccak256, toUtf8Bytes } from "ethers";

/** keccak256 of the UTF-8 payload. This is the only hash WYRVEL uses. */
export function commitmentOf(payload: string): string {
  return keccak256(toUtf8Bytes(payload));
}

export function isRecordId(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
