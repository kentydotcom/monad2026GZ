import { useEffect, useState } from "react";
import {
  chainAppend,
  chainAudit,
  chainObserve,
  chainPrune,
  chainTopology,
  type ChainAudit,
  type ChainNode,
  type ChainTopology,
} from "./api";
import { payloadBytes, payloadIssue, statusText, sharedValue, type StatusCode } from "./chainSession";
import { ChainPicture } from "./diagrams";
import { SAMPLE_NOTE } from "./evidence";
import { useT } from "./lang";

export function ChainPanel({ active }: { active: boolean }) {
  const { t, lang } = useT();
  const [topology, setTopology] = useState<ChainTopology | null>(null);
  const [blockText, setBlockText] = useState("");
  const [draft, setDraft] = useState(SAMPLE_NOTE);
  const [held, setHeld] = useState<ChainNode[] | null>(null);
  const [heldBlock, setHeldBlock] = useState<number | null>(null);
  const [current, setCurrent] = useState<ChainNode[] | null>(null);
  const [audit, setAudit] = useState<ChainAudit | null>(null);
  const [status, setStatus] = useState<StatusCode | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inputError, setInputError] = useState<"empty" | "too-large" | null>(null);

  async function loadTopology() {
    try {
      setTopology(await chainTopology());
    } catch {
      setTopology({ ok: false, code: "not-running" });
    }
  }

  useEffect(() => {
    void loadTopology();
  }, [active]);

  const running = Boolean(topology?.ok && topology.nodes && topology.nodes.length > 0);
  const block = /^\d+$/.test(blockText) ? Number(blockText) : null;
  const selected = block !== null && block > 0 ? block : null;
  const issue = payloadIssue(draft);
  const thenNodes = heldBlock !== null && heldBlock === selected ? held : null;
  const header = sharedValue((current ?? thenNodes)?.map((node) => node.headerHash) ?? []);
  const body = sharedValue((current ?? thenNodes)?.map((node) => node.bodyCommitment) ?? []);
  const heldText = held?.find((node) => node.payload)?.payload ?? null;
  const currentText = current?.find((node) => node.payload)?.payload ?? null;
  const currentGone = Boolean(current?.length && current.every((node) => !node.payloadPresent));
  const ids = topology?.nodes?.map((node) => node.id) ?? uniqueIds(thenNodes, current);

  async function readBlock(index: number) {
    const [view, record] = await Promise.all([chainObserve(index), chainAudit(index)]);
    setCurrent(Array.isArray(view.nodes) ? view.nodes : []);
    setAudit(record);
    await loadTopology();
  }

  async function onAppend() {
    const problem = payloadIssue(draft);
    setInputError(problem);
    if (problem || !running) return;
    setBusy("append");
    const started = Date.now();
    try {
      const result = await chainAppend(draft);
      const code = result.status === "accepted" || result.status === "rejected" || result.status === "incomplete" ? result.status : "rejected";
      if (result.ok && typeof result.index === "number") {
        setBlockText(String(result.index));
        setHeldBlock(result.index);
        const view = await chainObserve(result.index);
        const nodes = Array.isArray(view.nodes) ? view.nodes : [];
        setHeld(nodes);
        setCurrent(nodes);
        setAudit(await chainAudit(result.index));
      }
      await loadTopology();
      setStatus(code);
      setDetail(code === "accepted" ? null : result.code ?? null);
      setElapsed(Date.now() - started);
    } catch {
      setStatus("not-running");
    } finally {
      setBusy(null);
    }
  }

  async function onObserve() {
    if (selected === null) return;
    setBusy("observe");
    const started = Date.now();
    try {
      await readBlock(selected);
      setElapsed(Date.now() - started);
    } catch {
      setStatus("not-running");
    } finally {
      setBusy(null);
    }
  }

  async function onPrune() {
    if (selected === null) return;
    setBusy("prune");
    const started = Date.now();
    try {
      const result = await chainPrune(selected);
      const code = result.status === "accepted" || result.status === "rejected" || result.status === "incomplete" ? result.status : "rejected";
      if (code === "accepted" || code === "incomplete") await readBlock(selected);
      else await loadTopology();
      setStatus(code);
      setDetail(code === "accepted" ? null : result.code ?? null);
      setElapsed(Date.now() - started);
    } catch {
      setStatus("not-running");
    } finally {
      setBusy(null);
    }
  }

  function onClear() {
    setHeld(null);
    setHeldBlock(null);
    setCurrent(null);
    setAudit(null);
    setStatus(null);
    setDetail(null);
    setElapsed(null);
  }

  const leader = audit?.leader;

  return (
    <section className="panel">
      <p className="kicker">{t.chainKicker}</p>
      <h2>{t.chainTitle}</h2>
      <ChainPicture />
      <p className="kicker">{t.dMeasured}</p>
      {!running ? <p className="notice">{t.chainNotRunning}</p> : null}
      {running ? (
        <div className="topo">
          {topology?.nodes?.map((node) => (
            <article key={node.id}>
              <p className="kicker">{node.id}</p>
              <p>{node.role}</p>
              <p>{node.reachable ? `${t.chainHeight} ${node.height ?? t.dash}` : t.chainUnreachableNode}</p>
              <p>{node.ready ? t.chainReady : t.chainNotReady}</p>
            </article>
          ))}
        </div>
      ) : null}
      <label>
        <span>{t.payload}</span>
        <textarea
          className="chain"
          rows={3}
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setInputError(null);
          }}
        />
      </label>
      <p>
        {payloadBytes(draft)} / 4096 · {t.chainSynthetic}
      </p>
      {inputError ? <p className="notice">{inputError === "empty" ? t.chainEmpty : t.chainTooLarge}</p> : null}
      <label>
        <span>{t.chainIndex}</span>
        <input
          value={blockText}
          inputMode="numeric"
          onChange={(event) => {
            setBlockText(event.target.value.replace(/[^\d]/g, ""));
            setCurrent(null);
            setAudit(null);
          }}
        />
      </label>
      <div className="actions">
        <button className="action" type="button" onClick={onAppend} disabled={!running || busy !== null || issue !== null}>
          {busy === "append" ? t.chainAppending : t.chainAppend}
        </button>
        <button className="quiet" type="button" onClick={onObserve} disabled={!running || selected === null || busy !== null}>
          {busy === "observe" ? t.chainObserving : t.chainObserve}
        </button>
        <button className="quiet" type="button" onClick={onPrune} disabled={!running || selected === null || busy !== null}>
          {busy === "prune" ? t.chainPruning : t.chainPrune}
        </button>
        <button className="quiet" type="button" onClick={onClear} disabled={busy !== null}>
          {t.chainClear}
        </button>
      </div>
      {status || elapsed !== null || selected !== null ? (
        <p>
          {statusText(status, lang, detail)}
          {selected !== null ? ` · ${t.chainIndex} ${selected}` : ""}
          {elapsed !== null ? ` · ${elapsed} ms` : ""}
        </p>
      ) : null}
      {header || body ? (
        <p>
          {t.headerLabel} {header === "differs" ? t.chainDiffers : shortHash(header)}
          {" · "}
          {t.bodyLabel} {body === "differs" ? t.chainDiffers : shortHash(body)}
        </p>
      ) : null}
      {ids.length > 0 && (thenNodes || current) ? (
        <div className="matrix">
          <p className="kicker">{t.nodeLabel}</p>
          <p className="kicker">{t.chainThen}</p>
          <p className="kicker">{t.chainNow}</p>
          {ids.map((id) => (
            <Row key={id} id={id} thenNodes={thenNodes} current={current} />
          ))}
        </div>
      ) : null}
      {heldText && currentGone ? (
        <ul className="end tight">
          <li>{t.chainHeld}</li>
        </ul>
      ) : null}
      {leader?.found && leader.index !== null ? (
        <p>
          {t.chainAuditIndex} {leader.index}
          {" · "}
          {leader.authorized ? t.chainAuthorized : t.chainUnauthorizedAudit}
          {" · "}
          {t.chainHeight} {leader.height ?? t.dash}
        </p>
      ) : selected !== null && current ? (
        <p>{leader?.code === "fail-closed" ? t.chainFailClosed : t.chainNoAudit}</p>
      ) : null}
      <details className="chain-details">
        <summary>{t.chainDetails}</summary>
        <ul className="end tight">
          <li>{t.chainB2}</li>
          <li>{t.chainB3}</li>
          <li>{t.chainB4}</li>
          <li>{t.chainB5}</li>
          <li>{t.chainB6}</li>
          <li>{t.chainB8}</li>
          <li>{t.chainElapsedNote}</li>
          <li>{t.chainSynthetic}</li>
        </ul>
        <p className="kicker">{t.chainAuditTitle}</p>
        {leader?.found && leader.hash ? (
          <dl className="fields compact">
            <Field k={t.chainAuditIndex} v={leader.index === null ? t.dash : String(leader.index)} />
            <Field k={t.headerLabel} v={leader.hash} />
            <Field k={t.chainTarget} v={String(leader.target)} />
            <Field k={t.bodyLabel} v={leader.targetHeader ?? t.dash} />
            <Field k={t.chainLinked} v={leader.links ? t.chainLinked : t.chainUnlinked} />
            <Field k={t.chainAuthorized} v={leader.authorized ? t.chainAuthorized : t.chainUnauthorizedAudit} />
            <Field k={t.chainHeight} v={leader.height === null ? t.dash : String(leader.height)} />
            <Field k={t.roleLabel} v={leader.signer ?? t.dash} />
          </dl>
        ) : (
          <p>{leader?.code === "fail-closed" ? t.chainFailClosed : t.chainNoAudit}</p>
        )}
        {heldText ? (
          <>
            <p className="kicker">{t.chainHeldText}</p>
            <p>{heldText}</p>
          </>
        ) : null}
        {currentText ? (
          <>
            <p className="kicker">{t.chainNodeText}</p>
            <p>{currentText}</p>
          </>
        ) : null}
      </details>
    </section>
  );
}

function Row({ id, thenNodes, current }: { id: string; thenNodes: ChainNode[] | null; current: ChainNode[] | null }) {
  const { t } = useT();
  return (
    <>
      <p>{id}</p>
      <p>{cell(thenNodes, id, t)}</p>
      <p>{cell(current, id, t)}</p>
    </>
  );
}

function cell(nodes: ChainNode[] | null, id: string, t: ReturnType<typeof useT>["t"]): string {
  if (!nodes) return t.notObserved;
  const node = nodes.find((item) => item.nodeId === id);
  if (!node) return t.notObserved;
  return codeText(node.code, t);
}

function codeText(code: string, t: ReturnType<typeof useT>["t"]): string {
  if (code === "present") return t.payloadPresent;
  if (code === "pruned" || code === "absent") return t.payloadAbsent;
  if (code === "fail-closed") return t.chainFailClosed;
  if (code === "unreachable") return t.chainUnreachableNode;
  return t.notObserved;
}

function uniqueIds(thenNodes: ChainNode[] | null, current: ChainNode[] | null): string[] {
  return [...new Set([...(thenNodes ?? []).map((node) => node.nodeId), ...(current ?? []).map((node) => node.nodeId)])];
}

function shortHash(value: string | null | "differs"): string {
  if (!value || value === "differs") return "—";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
