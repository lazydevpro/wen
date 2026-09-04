import React from 'react';
import {C} from './brand';
import {LUNA} from './data/luna';

const {visibleCount, lead, timeSteps, bands, anchorPrice, bandHeight, closes} = LUNA;

/**
 * The x-axis carries three sections: the visible run, the runway the path travels before the grid
 * begins, and the eight bettable columns. Mirrors drawChart()/layoutGrid() in web/app.js — if the
 * geometry drifts, the cells stop sitting under the line they are supposed to describe.
 */
export const TOTAL_STEPS = visibleCount + lead + timeSteps - 1; // 17
export const GRID_LEFT = (visibleCount - 1 + lead) / TOTAL_STEPS; // 9/17

const HALF = (bands / 2) * bandHeight;
const LO = anchorPrice * (1 - HALF);
const HI = anchorPrice * (1 + HALF);

/** Fractional position (0..1) of a step on the x-axis. */
export const fx = (i: number) => i / TOTAL_STEPS;
/** Fractional position (0..1) of a price on the y-axis, measured from the top. */
export const fy = (p: number) => 1 - (p - LO) / (HI - LO);

export const VISIBLE = closes.slice(0, visibleCount);
/** Runway + resolved candles: drawn as one white path, but only the last eight are bettable. */
export const REVEALED = closes.slice(visibleCount, visibleCount + lead + timeSteps);

/** Multiplier for a cell, or 0 if the grid has no such cell. */
export const multAt = (t: number, p: number) => LUNA.grid.find((c) => c.t === t && c.p === p)?.m ?? 0;
export const fmtMult = (m: number) => (m >= 100 ? `${Math.round(m)}x` : `${m.toFixed(m < 10 ? 2 : 1)}x`);

const path = (pts: number[], offset: number, w: number, h: number) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${(fx(i + offset) * w).toFixed(2)} ${(fy(p) * h).toFixed(2)}`).join(' ');

/**
 * The chart itself. `revealCount` walks the white path forward one candle at a time — the same
 * gesture drawPartial() makes in the app when a round resolves.
 */
export const Chart: React.FC<{width: number; height: number; revealCount: number}> = ({
    width,
    height,
    revealCount,
}) => {
    const shown = REVEALED.slice(0, revealCount);
    const gridLeftPx = GRID_LEFT * width;
    const anchorY = fy(anchorPrice) * height;

    const headVal = shown.length ? shown[shown.length - 1] : VISIBLE[VISIBLE.length - 1];
    const headIdx = shown.length ? VISIBLE.length - 1 + shown.length : VISIBLE.length - 1;

    return (
        <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
            {/* band rules, only over the grid — they are the cells' horizon lines, not chart chrome */}
            {Array.from({length: bands + 1}, (_, b) => {
                const y = ((bands - b) / bands) * height;
                return <line key={b} x1={gridLeftPx} y1={y} x2={width} y2={y} stroke="rgba(255,255,255,0.045)" strokeWidth={1} />;
            })}

            <line x1={0} y1={anchorY} x2={width} y2={anchorY} stroke={C.hairlineStrong} strokeWidth={1} strokeDasharray="4 5" />

            {/* Blue is chrome — it marks the candles you were given. The revealed path is white,
                the brightest thing on screen, because it is the new information. */}
            <path d={path(VISIBLE, 0, width, height)} fill="none" stroke={C.blue} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
            {shown.length > 0 && (
                <path
                    d={path([VISIBLE[VISIBLE.length - 1], ...shown], VISIBLE.length - 1, width, height)}
                    fill="none"
                    stroke={C.ink}
                    strokeWidth={3}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            )}

            <circle cx={fx(headIdx) * width} cy={fy(headVal) * height} r={6} fill={shown.length ? C.ink : C.blue} />
        </svg>
    );
};
