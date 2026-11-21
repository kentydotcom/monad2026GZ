import type { ReactNode } from "react";
import { useT } from "./lang";

export function Picture({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="diagram" role="img" aria-label={label}>
      <figcaption className="kicker">{label}</figcaption>
      {children}
    </figure>
  );
}

export function NodeBox({ name, mark, hot, dim, gone }: { name: string; mark?: string; hot?: boolean; dim?: boolean; gone?: boolean }) {
  const tone = [hot ? "hot" : "", dim ? "dim" : "", gone ? "gone" : ""].filter(Boolean).join(" ");
  return (
    <div className={`dnode ${tone}`}>
      {mark ? <span>{mark}</span> : null}
      <strong>{name}</strong>
    </div>
  );
}

export function Arrow() {
  return (
    <svg className="darrow" viewBox="0 0 28 16" aria-hidden="true">
      <path d="M1 8h20M16 3l7 5-7 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function OverviewMap() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="lanes">
        <div className="lane">
          <p className="kicker">{t.dLegacy}</p>
          <div className="flow">
            <NodeBox name={t.dInput} />
            <Arrow />
            <NodeBox name={t.dTeam} />
            <Arrow />
            <NodeBox name={t.dHash} mark={t.dMonad} />
          </div>
        </div>
        <p className="split">{t.dSeparate}</p>
        <div className="lane host">
          <p className="kicker">{t.dPrivate}</p>
          <div className="flow">
            <NodeBox name={t.dLeader} />
            <NodeBox name={t.dReplica} />
            <NodeBox name={t.dReplica} />
            <Arrow />
            <NodeBox name={t.dMonad} mark={t.dAnchor} />
          </div>
          <p className="bound">{t.dHost} · {t.dNotBft}</p>
        </div>
      </div>
    </Picture>
  );
}

export function CommitFlow() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="lane">
        <div className="flow">
          <NodeBox name={t.dInput} />
          <Arrow />
          <NodeBox name={t.dTeam} />
          <Arrow />
          <NodeBox name={t.dHash} mark={t.dHashOnly} />
        </div>
        <p className="bound">{t.dMonad}</p>
      </div>
    </Picture>
  );
}

export function EraseFlow() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="lane">
        <div className="flow">
          <NodeBox name={t.dTeam} gone mark={t.dGone} />
          <NodeBox name={t.dHash} mark={t.dStays} />
        </div>
        <p className="bound">{t.dNoTx}</p>
      </div>
    </Picture>
  );
}

export function CheckSketch() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="sketch">
        <span />
        <span className="kicker">{t.before}</span>
        <span className="kicker">{t.after}</span>
        <span className="kicker">{t.dSeal}</span>
        <NodeBox name={t.dStays} />
        <NodeBox name={t.dStays} />
        <span className="kicker">{t.dCopy}</span>
        <NodeBox name={t.dStays} />
        <NodeBox name={t.dGone} gone />
      </div>
      <p className="bound">{t.dActive}</p>
    </Picture>
  );
}

export function FeeSketch({ limit, price, fee, clock }: { limit: string; price: string; fee: string; clock: string }) {
  const { t } = useT();
  return (
    <Picture label={t.dMeasured}>
      <div className="flow">
        <NodeBox name={limit} mark={t.gasCharged} />
        <span className="op">×</span>
        <NodeBox name={price} mark={t.gasPrice} />
        <span className="op">=</span>
        <NodeBox name={fee} mark={t.fee} />
      </div>
      <div className="flow">
        <NodeBox name={clock} mark={t.dClock} />
        <span className="op">≠</span>
        <NodeBox name={t.dNotFinal} />
      </div>
    </Picture>
  );
}

export function WhySplit() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="lanes">
        <div className="lane">
          <p className="kicker">{t.dMonad}</p>
          <div className="flow">
            <NodeBox name={t.dReceipt} />
            <NodeBox name={t.dFee} />
            <NodeBox name={t.dClock} />
          </div>
        </div>
        <div className="lane host">
          <p className="kicker">{t.dPrivate}</p>
          <div className="flow">
            <NodeBox name={t.dBody} />
            <NodeBox name={t.dHeader} mark={t.dStays} />
          </div>
          <p className="bound">{t.dNotBft}</p>
        </div>
      </div>
    </Picture>
  );
}

export function StepRail({ step }: { step: number }) {
  const { t } = useT();
  const names = [t.step1, t.step2, t.step3, t.step4, t.step5, t.step6];
  return (
    <Picture label={t.dPicture}>
      <div className="rail">
        {names.map((name, index) => (
          <NodeBox key={name} name={name} hot={index + 1 === step} dim={index + 1 !== step} />
        ))}
      </div>
    </Picture>
  );
}

export function ChainPicture() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="lanes">
        <div className="lane host">
          <p className="kicker">{t.dHost}</p>
          <div className="flow">
            <NodeBox name={t.dLeader} />
            <NodeBox name={t.dReplica} />
            <NodeBox name={t.dReplica} />
          </div>
          <div className="flow">
            <NodeBox name={t.dBody} />
            <Arrow />
            <NodeBox name={t.dGone} gone />
          </div>
          <div className="flow">
            <NodeBox name={t.dHeader} mark={t.dStays} />
            <NodeBox name={t.dAudit} mark={t.dStays} />
            <Arrow />
            <NodeBox name={t.dMonad} mark={t.dAnchor} />
          </div>
          <p className="bound">{t.dNotBft} · {t.dNotBackup} · {t.dNotForensic} · {t.dNotFinal}</p>
        </div>
        <div className="lane">
          <p className="kicker">{t.dBrowser}</p>
          <NodeBox name={t.dCopy} mark={t.dSeparate} />
        </div>
      </div>
    </Picture>
  );
}

export function AnchorLink() {
  const { t } = useT();
  return (
    <Picture label={t.dPicture}>
      <div className="flow">
        <NodeBox name={t.dLeader} />
        <NodeBox name={t.dReplica} />
        <NodeBox name={t.dReplica} />
        <Arrow />
        <NodeBox name={t.dMonad} mark={t.dAnchor} />
      </div>
      <p className="bound">{t.dHashOnly} · {t.dNotFinal}</p>
    </Picture>
  );
}
