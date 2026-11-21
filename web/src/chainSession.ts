import { copy, type Lang } from "./i18n.ts";

export const MAX_CHAIN_BYTES = 4096;

export type StatusCode = "accepted" | "rejected" | "incomplete" | "not-running";

export function payloadBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function payloadIssue(text: string): "empty" | "too-large" | null {
  const bytes = payloadBytes(text);
  if (bytes === 0) return "empty";
  if (bytes > MAX_CHAIN_BYTES) return "too-large";
  return null;
}

export function statusText(code: StatusCode | null, lang: Lang, detail: string | null = null): string {
  const t = copy[lang];
  if (code === "accepted") return t.chainAccepted;
  if (code === "incomplete") return t.chainIncomplete;
  if (code === "not-running") return t.chainNotRunning;
  if (code === "rejected") return detail ? `${t.chainRejected} · ${detail}` : t.chainRejected;
  return t.notObserved;
}

export function sharedValue(values: Array<string | null | undefined>): string | null | "differs" {
  const present = values.filter((item): item is string => Boolean(item));
  if (present.length === 0) return null;
  if (new Set(present).size === 1) return present[0] ?? null;
  return "differs";
}
