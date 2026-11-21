import { useEffect, useState } from "react";
import { chainAppend, chainObserve, chainPrune, chainTopology, type ChainNode, type ChainOp, type ChainTopology } from "./api";
import { SAMPLE_NOTE } from "./evidence";
import { useT } from "./lang";

export function ChainPanel() {
  const { t } = useT();
  const [topology, setTopology] = useState<ChainTopology | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [before, setBefore] = useState<ChainNode[] | null>(null);
  const [after, setAfter] = useState<ChainNode[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    chainTopology()
      .then((value) => {
        if (!gone) setTopology(value);
      })
      .catch(() => {
        if (!gone) setTopology({ ok: false, code: "not-running" });
      });
    return () => {
      gone = true;
    };
  }, []);

  const running = Boolean(topology?.ok && topology.nodes && topology.nodes.length > 0);

  async function refresh(nextIndex: number, slot: "before" | "after") {
    const view = await chainObserve(nextIndex);
    const nodes = Array.isArray(view.nodes) ? view.nodes : [];
    if (slot === "before") setBefore(nodes);
    else setAfter(nodes);
    return view;
  }

  async function onAppend() {
    setBusy("append");
    setStatus(null);
    const started = Date.now();
    try {
      const result = await chainAppend(SAMPLE_NOTE);
      setStatus(labelStatus(result, t));
      if (result.ok && typeof result.index === "number") {
        setIndex(result.index);
        setAfter(null);
        await refresh(result.index, "before");
      }
      setElapsed(Date.now() - started);
    } catch {
      setStatus(t.chainNotRunning);
    } finally {
      setBusy(null);
    }
  }

  async function onObserve() {
    if (index === null) return;
    setBusy("observe");
    const started = Date.now();
    try {
      await refresh(index, after ? "after" : "before");
      setElapsed(Date.now() - started);
    } catch {
      setStatus(t.chainNotRunning);
    } finally {
      setBusy(null);
    }
  }

  async function onPrune() {
    if (index === null) return;
    setBusy("prune");
    const started = Date.now();
    try {
      const result = await chainPrune(index);
      setStatus(labelStatus(result, t));
      if (result.status === "accepted" || result.status === "incomplete") {
        await refresh(index, "after");
      }
      setElapsed(Date.now() - started);
    } catch {
      setStatus(t.chainNotRunning);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <p className="kicker">{t.chainKicker}</p>
      <h2>{t.chainTitle}</h2>
      <ul className="end tight">
        <li>{t.chainB1}</li>
        <li>{t.chainB2}</li>
        <li>{t.chainB3}</li>
        <li>{t.chainB4}</li>
        <li>{t.chainB5}</li>
        <li>{t.chainB6}</li>
        <li>{t.chainB7}</li>
        <li>{t.chainB8}</li>
        <li>{t.chainB9}</li>
        <li>{t.scenario}</li>
        {!running ? <li>{t.chainNotRunning}</li> : null}
      </ul>
      {running ? (
        <ul className="end tight">
          {topology?.nodes?.map((node) => (
            <li key={node.id}>
              {node.id} · {node.role} · {node.reachable ? `${t.chainHeight} ${node.height ?? "—"}` : t.chainUnreachableNode}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="actions">
        <button className="action" type="button" onClick={onAppend} disabled={!running || busy !== null}>
          {busy === "append" ? t.chainAppending : t.chainAppend}
        </button>
        <button className="quiet" type="button" onClick={onObserve} disabled={!running || index === null || busy !== null}>
          {busy === "observe" ? t.chainObserving : t.chainObserve}
        </button>
        <button className="quiet" type="button" onClick={onPrune} disabled={!running || index === null || busy !== null}>
          {busy === "prune" ? t.chainPruning : t.chainPrune}
        </button>
      </div>
      {index !== null ? (
        <dl className="fields compact">
          <Field k={t.chainIndex} v={String(index)} />
          <Field k={t.chainStatus} v={status ?? t.notObserved} />
          <Field k={t.chainElapsed} v={elapsed === null ? t.notMeasured : `${elapsed} ms`} />
        </dl>
      ) : null}
      {elapsed !== null ? (
        <ul className="end tight">
          <li>{t.chainElapsedNote}</li>
        </ul>
      ) : null}
      <div className="evidence-grid">
        <NodeColumn title={t.chainBefore} nodes={before} />
        <NodeColumn title={t.chainAfter} nodes={after} />
      </div>
    </section>
  );
}

function NodeColumn({ title, nodes }: { title: string; nodes: ChainNode[] | null }) {
  const { t } = useT();
  if (!nodes) {
    return (
      <article className="card">
        <p className="kicker">{title}</p>
        <p>{t.notObserved}</p>
      </article>
    );
  }
  return (
    <div>
      <p className="kicker">{title}</p>
      {nodes.map((node) => (
        <article className="card" key={`${title}-${node.nodeId}`}>
          <p className="kicker">
            {node.nodeId} · {node.role}
          </p>
          <dl className="fields compact">
            <Field k={t.codeLabel} v={codeText(node.code, t)} />
            <Field k={t.headerLabel} v={shortHash(node.headerHash) ?? t.dash} />
            <Field k={t.bodyLabel} v={shortHash(node.bodyCommitment) ?? t.dash} />
            <Field k={t.payloadLabel} v={node.payloadPresent && node.payload ? node.payload : t.payloadAbsent} />
          </dl>
        </article>
      ))}
    </div>
  );
}

function codeText(code: string, t: ReturnType<typeof useT>["t"]): string {
  if (code === "present") return t.payloadPresent;
  if (code === "pruned") return t.payloadAbsent;
  if (code === "fail-closed") return t.chainFailClosed;
  if (code === "unreachable") return t.chainUnreachableNode;
  if (code === "missing" || code === "absent") return t.notObserved;
  return code;
}

function labelStatus(result: ChainOp, t: ReturnType<typeof useT>["t"]): string {
  if (result.status === "accepted") return t.chainAccepted;
  if (result.status === "incomplete") return t.chainIncomplete;
  if (result.status === "rejected") return `${t.chainRejected} · ${result.code ?? ""}`.trim();
  if (result.code === "not-running") return t.chainNotRunning;
  return result.code ?? t.chainRejected;
}

function shortHash(value: string | null): string | null {
  if (!value) return null;
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
