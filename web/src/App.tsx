import { useEffect, useState, type FormEvent } from "react";
import {
  check,
  commit,
  erase,
  explorerHref,
  fetchMeta,
  formatPin,
  runStep,
  scanHref,
  type CheckResponse,
  type CommitResponse,
  type Meta,
  type StepResponse,
} from "./api";
import { HashDisc, IconChain, IconCheck, IconErase, IconPin, SealFigure } from "./icons";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "commit", label: "Commit" },
  { id: "erase", label: "Erase" },
  { id: "check", label: "Check" },
  { id: "why", label: "Why Monad" },
  { id: "e2e", label: "E2E" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STEPS = [
  { n: 1, label: "1 Deploy" },
  { n: 2, label: "2 Commit" },
  { n: 3, label: "3 Match" },
  { n: 4, label: "4 Erase" },
  { n: 5, label: "5 Recover" },
  { n: 6, label: "6 Seal" },
] as const;

const RECORD_KEY = "wyrvel.recordId";

function parseLocation(): { tab: TabId; step: number } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [head, tail] = raw.split("/");
  const tab = TABS.some((item) => item.id === head) ? (head as TabId) : "overview";
  const step = Math.min(6, Math.max(1, Number(tail) || 1));
  return { tab, step };
}

function writeLocation(tab: TabId, step: number) {
  const next = tab === "e2e" ? `#/e2e/${step}` : `#/${tab}`;
  if (window.location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

export function App() {
  const initial = parseLocation();
  const [tab, setTab] = useState<TabId>(initial.tab);
  const [step, setStep] = useState(initial.step);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [recordId, setRecordId] = useState(() => sessionStorage.getItem(RECORD_KEY) ?? "");

  useEffect(() => {
    const onHash = () => {
      const next = parseLocation();
      setTab(next.tab);
      setStep(next.step);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    writeLocation(tab, step);
  }, [tab, step]);

  useEffect(() => {
    let gone = false;
    fetchMeta()
      .then((value) => {
        if (!gone) setMeta(value);
      })
      .catch((err: unknown) => {
        if (gone) return;
        setMeta({
          ok: false,
          hash: "keccak256",
          contract: null,
          chainId: null,
          chainName: "Unreachable",
          chainError: err instanceof Error ? err.message : "The store did not answer.",
        });
      });
    return () => {
      gone = true;
    };
  }, [tab]);

  function remember(id: string) {
    setRecordId(id);
    sessionStorage.setItem(RECORD_KEY, id);
  }

  function open(next: TabId) {
    setTab(next);
  }

  const chip = meta?.chainError
    ? "Chain unreachable"
    : meta
      ? `${meta.chainName}${meta.chainId !== null ? ` · ${meta.chainId}` : ""}`
      : "Connecting";

  return (
    <div className="app">
      <header className="top">
        <div className="wrap brand">
          <button className="brand-name" type="button" onClick={() => open("overview")}>
            <HashDisc size={36} />
            <span>Wyrvel</span>
          </button>
          <p className="chain-chip meta">{chip}</p>
        </div>
        <div className="wrap">
          <nav className="tabs" aria-label="Judge tour">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => open(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {tab === "e2e" ? (
            <nav className="steps" aria-label="End-to-end steps">
              {STEPS.map((item) => (
                <button
                  key={item.n}
                  type="button"
                  role="tab"
                  aria-selected={step === item.n}
                  onClick={() => setStep(item.n)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          ) : null}
        </div>
      </header>
      <main className="wrap" role="tabpanel">
        {tab === "overview" ? <Overview /> : null}
        {tab === "commit" ? <CommitPanel meta={meta} onCommitted={remember} /> : null}
        {tab === "erase" ? <ErasePanel recordId={recordId} onRecord={remember} /> : null}
        {tab === "check" ? <CheckPanel recordId={recordId} onRecord={remember} /> : null}
        {tab === "why" ? <WhyPanel /> : null}
        {tab === "e2e" ? <E2EPanel step={step} /> : null}
        <footer className="foot">
          <p>Kent G Lau, PhD</p>
          <p>Temporary working name.</p>
        </footer>
      </main>
    </div>
  );
}

function Overview() {
  return (
    <section>
      <div className="hero">
        <HashDisc size={84} />
        <h1>WYRVEL</h1>
        <h2 className="lede">Pin a hash. Keep the data private. Erase it. Check that it is gone.</h2>
      </div>
      <hr className="rule" />
      <div className="triad">
        <article>
          <p className="kicker">
            <IconPin /> Commit
          </p>
          <h2>Only a 32-byte hash is pinned on Monad.</h2>
          <p>The payload stays in WYRVEL.</p>
        </article>
        <article>
          <p className="kicker">
            <IconErase /> Erase
          </p>
          <h2>The private copy is removed. The on-chain seal does not change.</h2>
        </article>
        <article>
          <p className="kicker">
            <IconCheck /> Check
          </p>
          <h2>A second party still sees the seal, and cannot recover the payload.</h2>
        </article>
      </div>
      <hr className="rule" />
      <SealFigure />
      <ul className="end">
        <li>Commit stores the payload privately and pins keccak256 on Monad.</li>
        <li>Erase removes that private copy and leaves the seal untouched.</li>
        <li>Check reads the seal and tries to recover the payload.</li>
      </ul>
    </section>
  );
}

function CommitPanel({
  meta,
  onCommitted,
}: {
  meta: Meta | null;
  onCommitted: (id: string) => void;
}) {
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);
  const explorer = explorerHref(result?.pin.explorer);
  const scan = scanHref(result?.pin.monadscan);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await commit(payload);
      setResult(next);
      onCommitted(next.recordId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">
        <IconPin /> Operator · Commit
      </p>
      <h2>Only a 32-byte hash is pinned on Monad.</h2>
      <p>
        The payload stays in WYRVEL. keccak256 of the UTF-8 bytes is pinned under a new record id.
        The transaction does not carry the payload.
      </p>
      {meta?.chainError ? <p className="notice">{meta.chainError}</p> : null}
      <form onSubmit={onSubmit}>
        <label>
          <span>Payload</span>
          <textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder="A sentence the team can erase."
            required
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Committing" : "Commit"}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {result ? (
        <dl className="fields">
          <Field k="Transaction" v={result.pin.txHash} />
          <Field k="Record" v={result.recordId} />
          <Field k="keccak256" v={result.commitment} />
          <Field k="Pinned" v={formatPin(result.pin.pinnedAt)} />
          <Field k="Pinner" v={result.pin.pinner} />
        </dl>
      ) : null}
      {explorer ? (
        <div className="links">
          <a href={explorer} target="_blank" rel="noreferrer">
            Open the seal on MonadVision
          </a>
          {scan ? (
            <a href={scan} target="_blank" rel="noreferrer">
              Open the seal on Monadscan
            </a>
          ) : null}
        </div>
      ) : result ? (
        <p>This chain is not Monad testnet, so there is no public explorer link.</p>
      ) : null}
      <ul className="end">
        <li>The payload stays in the store the team controls.</li>
        <li>Monad records the hash, the timestamp, and the record id.</li>
        <li>A testnet transaction links to the official explorer.</li>
      </ul>
    </section>
  );
}

function ErasePanel({
  recordId,
  onRecord,
}: {
  recordId: string;
  onRecord: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erasedAt, setErasedAt] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErasedAt(null);
    try {
      const next = await erase(recordId.trim());
      setErasedAt(next.erasedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erase failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">
        <IconErase /> Operator · Erase
      </p>
      <h2>The private copy is removed. The on-chain seal does not change.</h2>
      <p>
        Erase destroys the payload held by WYRVEL for this record id. It does not send a Monad
        transaction, and it does not alter the seal.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          <span>Record id</span>
          <textarea
            className="record"
            rows={2}
            value={recordId}
            onChange={(event) => onRecord(event.target.value.replace(/\s+/g, ""))}
            spellCheck={false}
            autoCapitalize="off"
            required
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Erasing" : "Erase"}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {erasedAt ? (
        <dl className="fields">
          <Field k="Record" v={recordId} />
          <Field k="Private copy" v="Unrecoverable" />
          <Field k="Erased" v={erasedAt.replace(".000Z", "Z")} />
        </dl>
      ) : null}
      <ul className="end">
        <li>The stored payload is no longer returned.</li>
        <li>The Monad seal is left as it was.</li>
        <li>Check is the separate view that reads both.</li>
      </ul>
    </section>
  );
}

function CheckPanel({
  recordId,
  onRecord,
}: {
  recordId: string;
  onRecord: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResponse | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await check(recordId.trim());
      setResult(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Check failed.");
    } finally {
      setBusy(false);
    }
  }

  const explorer = explorerHref(result?.explorer);
  const scan = scanHref(result?.monadscan);

  return (
    <section className="panel">
      <p className="kicker">
        <IconCheck /> Checker
      </p>
      <h2>A second party still sees the seal, and cannot recover the payload.</h2>
      <p>
        This view reads the on-chain seal, then asks WYRVEL for the payload. Before erase, the
        payload comes back and keccak256 matches the seal. After erase, the seal is unchanged and
        the payload does not come back.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          <span>Record id</span>
          <textarea
            className="record"
            rows={2}
            value={recordId}
            onChange={(event) => onRecord(event.target.value.replace(/\s+/g, ""))}
            spellCheck={false}
            autoCapitalize="off"
            required
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? "Checking" : "Check"}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {result ? (
        <dl className="fields">
          <Field k="Payload" v={result.recoverable ? "Recovered from WYRVEL" : "Unrecoverable"} />
          {result.recoverable && result.payload !== null ? <Field k="Text" v={result.payload} /> : null}
          <Field
            k="Match"
            v={
              result.matches === true
                ? "keccak256 matches the seal"
                : result.matches === false
                  ? "keccak256 does not match the seal"
                  : "No payload to compare"
            }
          />
        </dl>
      ) : null}
      {result?.seal ? (
        <dl className="fields">
          <Field k="Seal" v={result.seal.pinned ? result.seal.commitment : "Not pinned"} />
          <Field k="Pinned" v={result.seal.pinned ? formatPin(result.seal.pinnedAt) : "—"} />
          <Field k="Pinner" v={result.seal.pinned ? result.seal.pinner : "—"} />
          <Field k="Transaction" v={result.txHash ?? "—"} />
        </dl>
      ) : null}
      {explorer ? (
        <div className="links">
          <a href={explorer} target="_blank" rel="noreferrer">
            Open the seal on MonadVision
          </a>
          {scan ? (
            <a href={scan} target="_blank" rel="noreferrer">
              Open the seal on Monadscan
            </a>
          ) : null}
        </div>
      ) : null}
      <ul className="end">
        <li>The seal is read from Monad, not from the store’s memory of it.</li>
        <li>Recovery either returns the payload or it does not.</li>
        <li>After erase, the contrast is the seal still there and the payload gone.</li>
      </ul>
    </section>
  );
}

function WhyPanel() {
  return (
    <section className="why">
      <p className="kicker">
        <IconChain /> Why Monad
      </p>
      <h2>Sub-second L1 finality.</h2>
      <p>
        Commit pins a 32-byte hash. Check only works if a second party can treat that seal as
        already final. Official MonadBFT figures are 300 ms blocks, with a September 2026 mainnet
        mean of 302 ms, speculative finality in one slot, and full finality in two slots, about
        600 ms. Once a block is finalized, official docs say it cannot be reorged.
      </p>
      <h2>Cheap capacity for many small pins.</h2>
      <p>
        The public adapter is a high volume of tiny writes: a 32-byte commitment, an event, and an
        immutable record. At the official minimum base fee of 100 MON-gwei and no priority fee, a
        typical 200,000-gas call costs 0.02 MON. Design capacity is 10,000+ transactions per
        second, with a 150M gas block budget. Saturday’s demo uses testnet MON. The case is Monad
        as the settlement layer for many small pins.
      </p>
      <h2>A seal a second party can check.</h2>
      <p>
        Check is the contrast: the seal is still on chain, and the payload is gone from the team
        store. A checker can read the transaction on the official testnet explorers. Saturday uses
        chain id 10143, MonadVision, and Monadscan.
      </p>
      <div className="links">
        <a href="https://docs.monad.xyz/introduction/why-monad" target="_blank" rel="noreferrer">
          Why Monad
        </a>
        <a href="https://docs.monad.xyz/monad-arch/consensus/monad-bft" target="_blank" rel="noreferrer">
          MonadBFT
        </a>
        <a href="https://docs.monad.xyz/developer-essentials/gas-pricing" target="_blank" rel="noreferrer">
          Gas pricing
        </a>
        <a href="https://docs.monad.xyz/developer-essentials/historical-data" target="_blank" rel="noreferrer">
          Historical data
        </a>
      </div>
      <ul className="end">
        <li>300 ms blocks, full finality in two slots.</li>
        <li>Room for many 32-byte pins.</li>
        <li>Official explorers a checker can open.</li>
      </ul>
    </section>
  );
}

const STEP_COPY: Record<number, { title: string; body: string; success: string[] }> = {
  1: {
    title: "Deploy or locate the seal contract.",
    body: "This step reads the configured RPC and the chain id. If a seal address is already set, it checks that the address holds contract code and uses that seal. If no address is set, it deploys WyrvelSeal and keeps the new address for the later steps. Success is an address with code on the chain that answered. If the RPC does not answer, the step stops and shows that error.",
    success: [
      "The chain id is the chain that answered.",
      "The seal address has bytecode.",
      "A failed RPC is shown and not replaced with a fake result.",
    ],
  },
  2: {
    title: "Commit a payload and pin its hash.",
    body: "A short UTF-8 sentence is written into the WYRVEL store under a new record id. The store hashes those bytes with keccak256 and sends a transaction that pins the 32-byte hash on the seal. The payload is not in the transaction. Success is a record id, the hash, a pin timestamp, and a mined transaction hash. On Monad testnet the hash is linked to the public explorer. On a local chain the transaction is real for that node, and no public explorer link is invented.",
    success: [
      "The store holds the payload under the record id.",
      "The transaction hash is mined on this chain.",
      "Monad testnet links to MonadVision. Other chains do not.",
    ],
  },
  3: {
    title: "Verify the payload matches the seal.",
    body: "The checker reads the payload back from the store and reads the seal with a separate chain call. keccak256 of the recovered bytes is compared with the on-chain commitment for the same record id. Success is an exact match. This is the view from before erase. If the copy is already gone, the step fails because there is nothing left to match.",
    success: [
      "The store returns the payload.",
      "The chain returns a pinned seal for the record id.",
      "The two hashes are equal.",
    ],
  },
  4: {
    title: "Erase the private copy.",
    body: "The operator asks WYRVEL to erase the stored payload for the record id from step 2. The store removes that private copy. This step does not send a transaction and does not call the seal. Success is a store response that the payload is no longer held. The earlier transaction hash is left as it was.",
    success: [
      "The store accepts the erase.",
      "No new seal transaction is required.",
      "The previous transaction hash is unchanged.",
    ],
  },
  5: {
    title: "Verify the payload is unrecoverable.",
    body: "The checker asks the store for the same record id, the way a second party would. Success is a failed recovery: the payload is not returned, and the store directory does not still contain that text.",
    success: [
      "A read does not return the payload.",
      "The store directory does not contain the payload text.",
      "The record id is the one from the commit.",
    ],
  },
  6: {
    title: "Verify the on-chain seal is unchanged.",
    body: "The checker reads the seal for the same record id again. Success is the original 32-byte commitment, the same pinner, and the same pin timestamp as the commit in step 2. The payload stays unrecoverable. The seal was not edited.",
    success: [
      "Commitment, timestamp, and pinner match the commit.",
      "The payload is still unrecoverable.",
      "The pin transaction hash is the one from step 2.",
    ],
  },
};

function E2EPanel({ step }: { step: number }) {
  const copy = STEP_COPY[step] ?? STEP_COPY[1]!;
  const [runs, setRuns] = useState<Record<number, StepResponse>>({});
  const [busy, setBusy] = useState(false);
  const current = runs[step];

  async function onRun() {
    setBusy(true);
    try {
      const result = await runStep(step);
      setRuns((prev) => ({ ...prev, [step]: result }));
    } catch (err) {
      setRuns((prev) => ({
        ...prev,
        [step]: {
          ok: false,
          step,
          log: [],
          error: err instanceof Error ? err.message : "The step did not run.",
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">E2E · Step {step} of 6</p>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <p className="meta">Same steps as scripts/e2e.sh.</p>
      <div className="actions">
        <button className="action" type="button" onClick={onRun} disabled={busy}>
          {busy ? "Running" : "Run this step"}
        </button>
      </div>
      {current?.error ? <p className="notice" role="alert">{current.error}</p> : null}
      {current && current.log.length > 0 ? (
        <ul className="log">
          {current.log.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <ul className="end">
        {copy.success.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
