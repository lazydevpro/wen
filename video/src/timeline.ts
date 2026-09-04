import {interpolate} from 'remotion';

/**
 * Every cut point in the video, in absolute frames at 30fps.
 *
 * One table, because the only thing that matters about these numbers is their relationship to each
 * other. Nothing here is a hard cut: ranges deliberately overlap so one element is arriving while
 * the last is leaving, and the board behind them never goes away at all.
 */
export const T = {
    // ── act 1: the hook ──────────────────────────────────────────────
    openIn: 0,
    openOut: 130, // the opening starts leaving before the board arrives

    // ── act 2: one unbroken shot of the board, 0:04 → 0:34 ───────────
    boardIn: 138,
    riddleIn: 168,
    riddleOut: 352,

    whenIn: 344, // "you are never told when this is"
    whenOut: 428,

    gridIn: 448, // cells deal in on a diagonal
    betRailIn: 468,
    picksFrom: 536,
    picksEvery: 14,
    betRailOut: 652,

    payRailIn: 660, // overlaps the bet rail's exit, so the rail cross-dissolves instead of blinking
    revealFrom: 712,
    revealEvery: 15,

    eraIn: 884, // "this was May 2022."
    boardOut: 996,

    // ── act 3: the proof ─────────────────────────────────────────────
    counterIn: 1016,
    counterOut: 1122,

    // ── act 4: the end card ──────────────────────────────────────────
    endIn: 1136,
    end: 1260, // 42.0s
} as const;

export const DURATION = T.end;

/** Ramp 0→1 between `a` and `b`. */
export const rampIn = (frame: number, a: number, b: number) =>
    interpolate(frame, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/**
 * A trapezoid: absent before `a`, fully present from `b` to `c`, gone again by `d`.
 *
 * This is the whole transition vocabulary of the video. Nothing cuts — every element arrives and
 * leaves on a ramp, and neighbouring elements overlap so there is never a frame of nothing.
 */
export const win = (frame: number, a: number, b: number, c: number, d: number) =>
    interpolate(frame, [a, b, c, d], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** Cubic ease-out — snaps away, settles in. */
export const ease = (t: number) => 1 - Math.pow(1 - t, 3);
