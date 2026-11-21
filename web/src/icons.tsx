type IconProps = { size?: number };

export function HashDisc({ size = 72 }: IconProps) {
  return (
    <svg className="disc" width={size} height={size} viewBox="0 0 72 72" aria-hidden="true">
      <circle cx="36" cy="36" r="34" fill="none" stroke="#c6a36e" strokeWidth="1.25" />
      <circle cx="36" cy="36" r="28.5" fill="#241910" stroke="#8d6a3d" strokeWidth="1" />
      <g fill="#f3ecdf">
        <rect x="27" y="20" width="3.2" height="32" />
        <rect x="41.8" y="20" width="3.2" height="32" />
        <rect x="20" y="29" width="32" height="3.2" />
        <rect x="20" y="39.8" width="32" height="3.2" />
      </g>
    </svg>
  );
}

function stroke() {
  return {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinejoin: "miter" as const,
    strokeLinecap: "square" as const,
  };
}

export function IconPin({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" {...stroke()} />
      <path d="M9 8.5h6M9 12h6M9 15.5h6M10.2 7v10M13.8 7v10" {...stroke()} />
    </svg>
  );
}

export function IconErase({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" {...stroke()} />
      <path d="M8 12h8" {...stroke()} />
    </svg>
  );
}

export function IconCheck({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" {...stroke()} />
      <path d="M8 12.2l2.6 2.6L16.2 9" {...stroke()} />
    </svg>
  );
}

export function IconChain({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="7" width="6.5" height="10" {...stroke()} />
      <rect x="14" y="7" width="6.5" height="10" {...stroke()} />
      <path d="M10 12h4" {...stroke()} />
    </svg>
  );
}

export function SealFigure() {
  const cells = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      cells.push(
        <rect
          key={`${col}-${row}`}
          x={188 + col * 16}
          y={18 + row * 16}
          width="10"
          height="10"
          fill="none"
          stroke="#c6a36e"
          strokeWidth="1"
        />,
      );
    }
  }
  return (
    <svg className="figure" viewBox="0 0 360 110" role="img" aria-label="Seal leading to data">
      <circle cx="36" cy="48" r="28" fill="none" stroke="#c6a36e" strokeWidth="1.25" />
      <circle cx="36" cy="48" r="23" fill="#241910" stroke="#8d6a3d" strokeWidth="1" />
      <g fill="#f3ecdf">
        <rect x="28" y="34" width="2.4" height="28" />
        <rect x="41.6" y="34" width="2.4" height="28" />
        <rect x="22" y="42" width="28" height="2.4" />
        <rect x="22" y="51.6" width="28" height="2.4" />
      </g>
      <text x="78" y="52" fill="#e0c48a" fontSize="14" fontFamily="Source Serif 4, Palatino, serif">
        SEAL
      </text>
      <line
        x1="118"
        y1="48"
        x2="176"
        y2="48"
        stroke="#c6a36e"
        strokeWidth="1.25"
        strokeDasharray="1.5 4"
      />
      {cells}
      <text x="188" y="100" fill="#e0c48a" fontSize="14" fontFamily="Source Serif 4, Palatino, serif">
        DATA
      </text>
    </svg>
  );
}
