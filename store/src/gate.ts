import { timingSafeEqual } from "node:crypto";

export const GATE_USERNAME = "kent";

export function authorizeBasic(header: string | undefined, password: string): boolean {
  if (!header || !header.startsWith("Basic ") || !password) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  return safeEqual(user, GATE_USERNAME) && safeEqual(pass, password);
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim() ?? "";
    if (value.length < 8) continue;
    out = out.split(value).join("[redacted]");
    const bare = value.replace(/^0x/i, "");
    if (bare.length >= 8 && bare !== value) out = out.split(bare).join("[redacted]");
  }
  return out.replace(/0x[0-9a-fA-F]{64}/g, "0x…");
}
