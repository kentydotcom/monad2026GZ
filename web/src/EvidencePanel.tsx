import { explorerHref, scanHref } from "./api";
import { feeMon, gwei, type Evidence, type Side } from "./evidence";
import { useT } from "./lang";

export function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const { t } = useT();
  const explorer = explorerHref(evidence.explorer);
  const scan = scanHref(evidence.monadscan);
  const mon = feeMon(evidence.feeWei);
  const price = gwei(evidence.effectiveGasPrice);
  return (
    <section className="evidence" aria-label={t.before}>
      <div className="evidence-grid">
        <Card title={t.before} side={evidence.before} />
        <Card title={t.after} side={evidence.after} />
      </div>
      <dl className="fields compact">
        <Field k={t.fieldTx} v={evidence.txHash ?? t.notMeasured} />
        <Field k={t.gasCharged} v={evidence.gasLimit ?? t.notMeasured} />
        <Field k={t.gasPrice} v={price === null ? t.notMeasured : `${price} gwei`} />
        <Field k={t.fee} v={mon === null ? t.notMeasured : `${mon} MON`} />
        <Field k={t.roundTrip} v={evidence.roundTripMs === null ? t.notMeasured : `${evidence.roundTripMs} ms`} />
      </dl>
      <ul className="end tight">
        <li>{t.chargeNote}</li>
        {evidence.gasUsed && evidence.gasLimit && evidence.gasUsed !== evidence.gasLimit ? (
          <li>
            {t.gasUsed} {evidence.gasUsed}
          </li>
        ) : null}
        <li>{t.timingNote}</li>
      </ul>
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
    </section>
  );
}

function Card({ title, side }: { title: string; side: Side }) {
  const { t } = useT();
  return (
    <article className={`card ${side.kind}`}>
      <p className="kicker">{title}</p>
      <p>{labelFor(side, t)}</p>
      {side.commitment ? (
        <p className="meta">
          {t.fieldSeal} {side.commitment}
        </p>
      ) : null}
    </article>
  );
}

function labelFor(side: Side, t: ReturnType<typeof useT>["t"]): string {
  if (side.kind === "unknown") return t.notObserved;
  if (side.kind === "match") return t.observedMatch;
  if (side.kind === "gone") return t.observedGone;
  if (side.code === "unpaired") return t.unpaired;
  if (side.code === "seal-differs") return t.sealDiffers;
  if (side.code === "chain-unread") return t.chainUnread;
  if (side.code === "hash-mismatch") return t.hashMismatch;
  if (side.code === "still-there") return t.stillThere;
  if (side.kind === "mismatch") return t.observedMismatch;
  return t.observedError;
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
