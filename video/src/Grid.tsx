import React from 'react';
import {interpolate} from 'remotion';
import {C} from './brand';
import {LUNA} from './data/luna';
import {GRID_LEFT, fmtMult, multAt} from './Board';

const {bands, timeSteps} = LUNA;

/**
 * The round the video shows: one cell per column, 1 CTC each.
 *
 * Five of the eight land, which is a lucky round — the video is showing the upside, not a typical
 * result. Every multiplier is read out of the real grid, so the payout below is arithmetic on
 * shipped data rather than a number picked to look good.
 */
export const PICKS = [
    {t: 0, p: 4},
    {t: 1, p: 3},
    {t: 2, p: 5},
    {t: 3, p: 6},
    {t: 4, p: 4},
    {t: 5, p: 5},
    {t: 6, p: 4},
    {t: 7, p: 3},
] as const;

export const STAKE_EACH = 1;
export const TOTAL_STAKE = PICKS.length * STAKE_EACH;

const landedAt = (t: number) => LUNA.outcome.find((o) => o.t === t)?.p ?? -1;
const isWin = (pick: {t: number; p: number}) => landedAt(pick.t) === pick.p;

/** Returned CTC once `cols` columns have resolved. */
export const returnedAfter = (cols: number) =>
    PICKS.filter((pk) => pk.t < cols && isWin(pk)).reduce((sum, pk) => sum + multAt(pk.t, pk.p) * STAKE_EACH, 0);

export const TOTAL_RETURN = returnedAfter(timeSteps);

/**
 * The cell overlay, pinned to the same x-axis the chart uses so a cell always sits under the
 * stretch of line it describes.
 *
 * Three reveal states, each with a non-colour cue as well as a colour, exactly as the app does it:
 * landed (outline — where price actually went), won (filled green — your bet), lost (struck).
 * Green means YOUR bet won and never anything else.
 */
export const Grid: React.FC<{
    width: number;
    height: number;
    /** 0..1 — cells fading in as the grid is dealt */
    appear?: number;
    /** how many picks have been placed so far */
    picksPlaced?: number;
    /** how many columns have resolved */
    resolvedCols?: number;
}> = ({width, height, appear = 1, picksPlaced = 0, resolvedCols = 0}) => {
    const left = GRID_LEFT * width;
    const w = width - left;
    const colW = w / timeSteps;
    const rowH = height / bands;

    const cells: React.ReactNode[] = [];
    for (let row = 0; row < bands; row++) {
        const p = bands - 1 - row;
        for (let t = 0; t < timeSteps; t++) {
            const m = multAt(t, p);
            const pickIdx = PICKS.findIndex((pk) => pk.t === t && pk.p === p);
            const picked = pickIdx >= 0 && pickIdx < picksPlaced;
            const resolved = t < resolvedCols;
            const landed = resolved && landedAt(t) === p;
            const won = picked && landed;
            const lost = picked && resolved && !landed;

            // cells deal in on a diagonal, so the grid arrives as a sweep rather than a flash
            const cellAppear = interpolate(appear, [(t + row) / (timeSteps + bands), 1], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
            });

            // annotated because C is `as const`, so C.inkFaint is a literal type that would
            // otherwise pin these to one value
            let background: string = 'transparent';
            let border: string = 'rgba(255,255,255,0.05)';
            let color: string = C.inkFaint;
            let weight = 400;
            if (won) {
                background = C.win;
                border = C.win;
                color = '#04210f';
                weight = 600;
            } else if (lost) {
                background = 'rgba(255,77,77,0.14)';
                border = 'rgba(255,77,77,0.45)';
                color = C.lose;
            } else if (landed) {
                background = 'rgba(255,255,255,0.06)';
                border = 'rgba(255,255,255,0.5)';
                color = C.ink;
            } else if (picked) {
                background = 'rgba(73,118,255,0.3)';
                border = C.blue;
                color = '#fff';
                weight = 600;
            }

            cells.push(
                <div
                    key={`${t}:${p}`}
                    style={{
                        position: 'absolute',
                        left: left + t * colW,
                        top: row * rowH,
                        width: colW,
                        height: rowH,
                        boxSizing: 'border-box',
                        border: `1px solid ${border}`,
                        background,
                        color,
                        fontFamily: 'monospace',
                        fontSize: 15,
                        fontWeight: weight,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: cellAppear,
                        textDecoration: lost ? 'line-through' : 'none',
                    }}
                >
                    {m ? fmtMult(m) : ''}
                </div>,
            );
        }
    }

    return <div style={{position: 'absolute', inset: 0}}>{cells}</div>;
};
