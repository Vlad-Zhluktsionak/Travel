"use client";

import { useRef, useState } from "react";

export interface ChartPoint {
  id: number;
  cents: number;
  /** Preformatted on the server (display timezone, currency). */
  price: string;
  when: string;
  vsPaid: string;
  below: boolean;
}

interface Props {
  points: ChartPoint[];
  paidCents: number;
  paidLabel: string;
  lowLabel: string;
  firstDate: string;
  lastDate: string;
}

const W = 640, H = 200, PAD_L = 64, PAD_R = 12, PAD_T = 12, PAD_B = 24;

/** Price-history line with a snapping crosshair + tooltip (mouse, touch and arrow keys). */
export function PriceChart({ points, paidCents, paidLabel, lowLabel, firstDate, lastDate }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const values = [paidCents, ...points.map((p) => p.cents)];
  const min = Math.min(...values) * 0.97;
  const max = Math.max(...values) * 1.03;
  const x = (i: number) => PAD_L + (points.length === 1 ? (W - PAD_L - PAD_R) / 2 : (i / (points.length - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => PAD_T + (1 - (v - min) / (max - min || 1)) * (H - PAD_T - PAD_B);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join(" ");
  const lowest = Math.min(...points.map((p) => p.cents));

  /** Snap the pointer's X to the nearest check. */
  function nearest(clientX: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - vx) < Math.abs(x(best) - vx)) best = i;
    return best;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : points.length)) + step)));
  }

  const p = active === null ? null : points[active];
  // Keep the tooltip inside the chart: anchor left/right edges near the sides.
  const leftPct = p ? (x(active!) / W) * 100 : 0;
  const shift = leftPct < 20 ? "0%" : leftPct > 80 ? "-100%" : "-50%";

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Price history: ${points.length} checks, lowest ${lowLabel}, paid ${paidLabel}. Use left and right arrow keys to read each price.`}
        tabIndex={0}
        onPointerMove={(e) => setActive(nearest(e.clientX))}
        onPointerDown={(e) => setActive(nearest(e.clientX))}
        onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <line className="paid" x1={PAD_L} x2={W - PAD_R} y1={y(paidCents)} y2={y(paidCents)} />
        <text x={4} y={y(paidCents) + 4}>Paid {paidLabel}</text>
        <text x={4} y={y(lowest) + 4}>Low {lowLabel}</text>
        <path className="line" d={path} />
        {points.map((pt, i) => (
          <circle key={pt.id} className="dot" cx={x(i)} cy={y(pt.cents)} r={3} />
        ))}
        {p && (
          <g className="crosshair" aria-hidden="true">
            <line x1={x(active!)} x2={x(active!)} y1={PAD_T} y2={H - PAD_B} />
            <circle cx={x(active!)} cy={y(p.cents)} r={5} />
          </g>
        )}
        <text x={PAD_L} y={H - 6}>{firstDate}</text>
        <text x={W - PAD_R} y={H - 6} textAnchor="end">{lastDate}</text>
        {/* Transparent overlay so the whole plot area is the hit target, not just the 2px line. */}
        <rect x={PAD_L} y={0} width={W - PAD_L - PAD_R} height={H} fill="transparent" />
      </svg>
      {p && (
        <div className="chart-tip" role="status" style={{ left: `${leftPct}%`, transform: `translateX(${shift})` }}>
          <strong>{p.price}</strong>
          <span className={p.below ? "tip-good" : "muted"}>{p.vsPaid}</span>
          <span className="muted">{p.when}</span>
        </div>
      )}
    </div>
  );
}
