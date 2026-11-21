export type Meta = {
  ok: boolean;
  hash: string;
  contract: string | null;
  chainId: number | null;
  chainName: string;
  chainError: string | null;
};

export type Pin = {
  txHash: string;
  blockNumber: number;
  pinnedAt: number;
  pinner: string;
  chainId: number;
  explorer: string | null;
  monadscan: string | null;
};

export type CommitResponse = {
  ok: true;
  recordId: string;
  commitment: string;
  byteLength: number;
  storedAt: string;
  pin: Pin;
};

export type CheckResponse = {
  ok: boolean;
  recordId: string;
  recoverable: boolean;
  payload: string | null;
  seal: {
    pinned: boolean;
    commitment: string;
    pinnedAt: number;
    pinner: string;
  } | null;
  matches: boolean | null;
  txHash: string | null;
  explorer: string | null;
  monadscan: string | null;
  error?: string;
};

export type StepResponse = {
  ok: boolean;
  step: number;
  title?: string;
  log: string[];
  error?: string;
};

const VISION = /^https:\/\/testnet\.monadvision\.com\/tx\/0x[0-9a-fA-F]{64}$/;
const SCAN = /^https:\/\/testnet\.monadscan\.com\/tx\/0x[0-9a-fA-F]{64}$/;

export function explorerHref(value: string | null | undefined): string | null {
  if (!value || !VISION.test(value)) return null;
  return value;
}

export function scanHref(value: string | null | undefined): string | null {
  if (!value || !SCAN.test(value)) return null;
  return value;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 400) };
  }
}

function message(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === "string" && body.error.length > 0 ? body.error : fallback;
}

export async function fetchMeta(): Promise<Meta> {
  const res = await fetch("/v1/meta");
  const body = await readBody(res);
  if (!res.ok) throw new Error(message(body, "The store did not answer."));
  return body as unknown as Meta;
}

export async function commit(payload: string): Promise<CommitResponse> {
  const res = await fetch("/v1/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(message(body, "Commit failed."));
  return body as unknown as CommitResponse;
}

export async function erase(recordId: string): Promise<{ erasedAt: string | null }> {
  const res = await fetch(`/v1/records/${recordId}/erase`, { method: "POST" });
  const body = await readBody(res);
  if (!res.ok) throw new Error(message(body, "Erase failed."));
  return { erasedAt: typeof body.erasedAt === "string" ? body.erasedAt : null };
}

export async function check(recordId: string): Promise<CheckResponse> {
  const res = await fetch(`/v1/check/${recordId}`);
  const body = (await readBody(res)) as unknown as CheckResponse & { error?: string };
  if (!body || typeof body.recordId !== "string") {
    throw new Error("Check did not return a record.");
  }
  return body;
}

export async function runStep(step: number): Promise<StepResponse> {
  const res = await fetch(`/v1/e2e/steps/${step}`, { method: "POST" });
  const body = (await readBody(res)) as unknown as StepResponse;
  return {
    ok: Boolean(body.ok),
    step,
    title: body.title,
    log: Array.isArray(body.log) ? body.log : [],
    error: body.error,
  };
}

export function formatPin(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime()) || seconds === 0) return "—";
  return date.toISOString().replace(".000Z", "Z");
}
