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
import { chainLabel, translateError, translateLine } from "./i18n";
import { useT } from "./lang";

const TABS = [
  { id: "overview", key: "tabOverview" },
  { id: "commit", key: "tabCommit" },
  { id: "erase", key: "tabErase" },
  { id: "check", key: "tabCheck" },
  { id: "why", key: "tabWhy" },
  { id: "e2e", key: "tabE2e" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STEPS = [
  { n: 1, key: "step1" },
  { n: 2, key: "step2" },
  { n: 3, key: "step3" },
  { n: 4, key: "step4" },
  { n: 5, key: "step5" },
  { n: 6, key: "step6" },
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

  const { t, lang, setLang } = useT();
  const chip = !meta
    ? t.connecting
    : meta.chainError
      ? t.chainUnreachable
      : `${chainLabel(meta.chainName, lang, false)}${meta.chainId !== null ? ` · ${meta.chainId}` : ""}`;

  return (
    <div className="app">
      <header className="top">
        <div className="wrap brand">
          <button className="brand-name" type="button" onClick={() => open("overview")}>
            <HashDisc size={36} />
            <span>Wyrvel</span>
          </button>
          <div className="brand-tools">
            <div className="lang-switch" role="group" aria-label={t.langLabel}>
              <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
                {t.langEn}
              </button>
              <button type="button" aria-pressed={lang === "zh"} onClick={() => setLang("zh")}>
                {t.langZh}
              </button>
            </div>
            <p className="chain-chip meta">{chip}</p>
          </div>
        </div>
        <div className="wrap">
          <nav className="tabs" aria-label={t.tourLabel}>
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => open(item.id)}
              >
                {t[item.key]}
              </button>
            ))}
          </nav>
          {tab === "e2e" ? (
            <nav className="steps" aria-label={t.stepsLabel}>
              {STEPS.map((item) => (
                <button
                  key={item.n}
                  type="button"
                  role="tab"
                  aria-selected={step === item.n}
                  onClick={() => setStep(item.n)}
                >
                  {t[item.key]}
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
          <p>{t.byline}</p>
          <p>{t.workingName}</p>
        </footer>
      </main>
    </div>
  );
}

function Overview() {
  const { t } = useT();
  return (
    <section>
      <div className="hero">
        <HashDisc size={84} />
        <h1>WYRVEL</h1>
        <h2 className="lede">{t.lede}</h2>
      </div>
      <hr className="rule" />
      <div className="triad">
        <article>
          <p className="kicker">
            <IconPin /> {t.kCommit}
          </p>
          <h2>{t.overviewCommitTitle}</h2>
          <p>{t.overviewCommitBody}</p>
        </article>
        <article>
          <p className="kicker">
            <IconErase /> {t.kErase}
          </p>
          <h2>{t.overviewEraseTitle}</h2>
        </article>
        <article>
          <p className="kicker">
            <IconCheck /> {t.kCheck}
          </p>
          <h2>{t.overviewCheckTitle}</h2>
        </article>
      </div>
      <hr className="rule" />
      <SealFigure seal={t.figureSeal} data={t.figureData} label={t.figureLabel} />
      <ul className="end">
        <li>{t.overviewB1}</li>
        <li>{t.overviewB2}</li>
        <li>{t.overviewB3}</li>
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
  const { t, lang } = useT();
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
      setError(err instanceof Error ? err.message : t.commitFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">
        <IconPin /> {t.operatorCommit}
      </p>
      <h2>{t.overviewCommitTitle}</h2>
      <p>{t.commitBody}</p>
      {meta?.chainError ? <p className="notice">{translateError(meta.chainError, lang)}</p> : null}
      <form onSubmit={onSubmit}>
        <label>
          <span>{t.payload}</span>
          <textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder={t.payloadPlaceholder}
            required
            onInvalid={(event) => event.currentTarget.setCustomValidity(t.payloadRequired)}
            onInput={(event) => event.currentTarget.setCustomValidity("")}
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? t.committing : t.commit}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{translateError(error, lang)}</p> : null}
      {result ? (
        <dl className="fields">
          <Field k={t.fieldTx} v={result.pin.txHash} />
          <Field k={t.fieldRecord} v={result.recordId} />
          <Field k={t.fieldKeccak} v={result.commitment} />
          <Field k={t.fieldPinned} v={formatPin(result.pin.pinnedAt)} />
          <Field k={t.fieldPinner} v={result.pin.pinner} />
        </dl>
      ) : null}
      {explorer ? (
        <div className="links">
          <a href={explorer} target="_blank" rel="noreferrer">
            {t.openVision}
          </a>
          {scan ? (
            <a href={scan} target="_blank" rel="noreferrer">
              {t.openScan}
            </a>
          ) : null}
        </div>
      ) : result ? (
        <p>{t.noExplorer}</p>
      ) : null}
      <ul className="end">
        <li>{t.commitB1}</li>
        <li>{t.commitB2}</li>
        <li>{t.commitB3}</li>
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
  const { t, lang } = useT();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setErasedAt(null);
    try {
      const next = await erase(recordId.trim());
      setErasedAt(next.erasedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.eraseFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">
        <IconErase /> {t.operatorErase}
      </p>
      <h2>{t.overviewEraseTitle}</h2>
      <p>{t.eraseBody}</p>
      <form onSubmit={onSubmit}>
        <label>
          <span>{t.recordId}</span>
          <textarea
            className="record"
            rows={2}
            value={recordId}
            onChange={(event) => onRecord(event.target.value.replace(/\s+/g, ""))}
            spellCheck={false}
            autoCapitalize="off"
            required
            onInvalid={(event) => event.currentTarget.setCustomValidity(t.recordRequired)}
            onInput={(event) => event.currentTarget.setCustomValidity("")}
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? t.erasing : t.erase}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{translateError(error, lang)}</p> : null}
      {erasedAt ? (
        <dl className="fields">
          <Field k={t.fieldRecord} v={recordId} />
          <Field k={t.fieldCopy} v={t.unrecoverable} />
          <Field k={t.fieldErased} v={erasedAt.replace(".000Z", "Z")} />
        </dl>
      ) : null}
      <ul className="end">
        <li>{t.eraseB1}</li>
        <li>{t.eraseB2}</li>
        <li>{t.eraseB3}</li>
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
  const { t, lang } = useT();

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
      setError(err instanceof Error ? err.message : t.checkFailed);
    } finally {
      setBusy(false);
    }
  }

  const explorer = explorerHref(result?.explorer);
  const scan = scanHref(result?.monadscan);

  return (
    <section className="panel">
      <p className="kicker">
        <IconCheck /> {t.checker}
      </p>
      <h2>{t.overviewCheckTitle}</h2>
      <p>{t.checkBody}</p>
      <form onSubmit={onSubmit}>
        <label>
          <span>{t.recordId}</span>
          <textarea
            className="record"
            rows={2}
            value={recordId}
            onChange={(event) => onRecord(event.target.value.replace(/\s+/g, ""))}
            spellCheck={false}
            autoCapitalize="off"
            required
            onInvalid={(event) => event.currentTarget.setCustomValidity(t.recordRequired)}
            onInput={(event) => event.currentTarget.setCustomValidity("")}
          />
        </label>
        <div className="actions">
          <button className="action" type="submit" disabled={busy}>
            {busy ? t.checking : t.check}
          </button>
        </div>
      </form>
      {error ? <p className="notice" role="alert">{translateError(error, lang)}</p> : null}
      {result ? (
        <dl className="fields">
          <Field k={t.fieldPayload} v={result.recoverable ? t.recovered : t.unrecoverable} />
          {result.recoverable && result.payload !== null ? <Field k={t.fieldText} v={result.payload} /> : null}
          <Field
            k={t.fieldMatch}
            v={result.matches === true ? t.matchYes : result.matches === false ? t.matchNo : t.matchNone}
          />
        </dl>
      ) : null}
      {result?.seal ? (
        <dl className="fields">
          <Field k={t.fieldSeal} v={result.seal.pinned ? result.seal.commitment : t.notPinned} />
          <Field k={t.fieldPinned} v={result.seal.pinned ? formatPin(result.seal.pinnedAt) : t.dash} />
          <Field k={t.fieldPinner} v={result.seal.pinned ? result.seal.pinner : t.dash} />
          <Field k={t.fieldTx} v={result.txHash ?? t.dash} />
        </dl>
      ) : null}
      {explorer ? (
        <div className="links">
          <a href={explorer} target="_blank" rel="noreferrer">
            {t.openVision}
          </a>
          {scan ? (
            <a href={scan} target="_blank" rel="noreferrer">
              {t.openScan}
            </a>
          ) : null}
        </div>
      ) : null}
      <ul className="end">
        <li>{t.checkB1}</li>
        <li>{t.checkB2}</li>
        <li>{t.checkB3}</li>
      </ul>
    </section>
  );
}

function WhyPanel() {
  const { t } = useT();
  return (
    <section className="why">
      <p className="kicker">
        <IconChain /> {t.whyKicker}
      </p>
      <h2>{t.why1}</h2>
      <p>{t.why1Body}</p>
      <h2>{t.why2}</h2>
      <p>{t.why2Body}</p>
      <h2>{t.why3}</h2>
      <p>{t.why3Body}</p>
      <div className="links">
        <a href="https://docs.monad.xyz/introduction/why-monad" target="_blank" rel="noreferrer">
          {t.linkWhy}
        </a>
        <a href="https://docs.monad.xyz/monad-arch/consensus/monad-bft" target="_blank" rel="noreferrer">
          {t.linkBft}
        </a>
        <a href="https://docs.monad.xyz/developer-essentials/gas-pricing" target="_blank" rel="noreferrer">
          {t.linkGas}
        </a>
        <a href="https://docs.monad.xyz/developer-essentials/historical-data" target="_blank" rel="noreferrer">
          {t.linkHistory}
        </a>
      </div>
      <ul className="end">
        <li>{t.whyB1}</li>
        <li>{t.whyB2}</li>
        <li>{t.whyB3}</li>
      </ul>
    </section>
  );
}

function stepCopy(step: number, t: ReturnType<typeof useT>["t"]) {
  const steps = {
    1: { title: t.s1title, body: t.s1body, success: [t.s1a, t.s1b, t.s1c] },
    2: { title: t.s2title, body: t.s2body, success: [t.s2a, t.s2b, t.s2c] },
    3: { title: t.s3title, body: t.s3body, success: [t.s3a, t.s3b, t.s3c] },
    4: { title: t.s4title, body: t.s4body, success: [t.s4a, t.s4b, t.s4c] },
    5: { title: t.s5title, body: t.s5body, success: [t.s5a, t.s5b, t.s5c] },
    6: { title: t.s6title, body: t.s6body, success: [t.s6a, t.s6b, t.s6c] },
  } as const;
  return steps[step as 1 | 2 | 3 | 4 | 5 | 6] ?? steps[1];
}

function E2EPanel({ step }: { step: number }) {
  const { t, lang } = useT();
  const copy = stepCopy(step, t);
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
          error: err instanceof Error ? err.message : t.stepDidNotRun,
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">{t.e2eKicker.replace("{step}", String(step))}</p>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <p className="meta">{t.e2eSame}</p>
      <div className="actions">
        <button className="action" type="button" onClick={onRun} disabled={busy}>
          {busy ? t.running : t.runStep}
        </button>
      </div>
      {current?.error ? <p className="notice" role="alert">{translateError(current.error, lang)}</p> : null}
      {current && current.log.length > 0 ? (
        <ul className="log">
          {current.log.map((line) => (
            <li key={line}>{translateLine(line, lang)}</li>
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
