import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from './brand';
import {LUNA} from './data/luna';
import {Panel, Rail} from './Stage';
import {Typed} from './Typed';
import {PICKS, STAKE_EACH, TOTAL_RETURN, TOTAL_STAKE, returnedAfter} from './Grid';
import {multAt, fmtMult} from './Board';
import {display, mono, sans} from './fonts';
import {T, rampIn, win} from './timeline';

/**
 * Everything in here reads the absolute frame. Nothing is wrapped in a <Sequence>, because a
 * Sequence would restart the clock and re-mount the component — and a re-mount is exactly the
 * discontinuity the edit is trying to avoid. Beats overlap instead: each element has a window it
 * fades up and down over, and neighbouring windows touch.
 */

const tag = (text: string) => (
    <div style={{fontFamily: mono, fontSize: 15, letterSpacing: 2.2, color: C.inkFaint}}>{text}</div>
);

/** 0:05–0:12 — the riddle, the only thing you are told about *when* this is. */
export const RiddleRail: React.FC = () => {
    const frame = useCurrentFrame();
    const o = win(frame, T.boardIn, T.boardIn + 26, T.riddleOut, T.riddleOut + 24);
    const lift = interpolate(o, [0, 1], [16, 0]);

    return (
        <Rail opacity={o} lift={lift}>
            {tag('// ROUND 1 · THE ONLY CLUE')}
            <Panel style={{marginTop: 18, width: '100%'}} cutPx={16} border={C.hairlineStrong}>
                <div style={{padding: '30px 30px 34px'}}>
                    <Typed
                        text={LUNA.riddle}
                        from={T.riddleIn}
                        per={0.9}
                        size={34}
                        font={display}
                        lineHeight={1.42}
                        letterSpacing={0}
                        caretUntil={T.riddleOut}
                    />
                </div>
            </Panel>
            <div
                style={{
                    fontFamily: sans,
                    fontSize: 22,
                    color: C.inkMute,
                    marginTop: 26,
                    lineHeight: 1.6,
                    opacity: rampIn(frame, T.riddleIn + 96, T.riddleIn + 118),
                }}
            >
                eight real candles. no date, no ticker, no axis labels.
            </div>
        </Rail>
    );
};

/** 0:15–0:22 — the bet being placed, one pick per beat. */
export const BetRail: React.FC<{picksPlaced: number}> = ({picksPlaced}) => {
    const frame = useCurrentFrame();
    const o = win(frame, T.betRailIn, T.betRailIn + 26, T.betRailOut, T.betRailOut + 24);
    const lift = interpolate(o, [0, 1], [16, 0]);

    return (
        <Rail opacity={o} lift={lift}>
            {tag('// BET ON WHERE IT GOES NEXT')}
            <div
                style={{
                    fontFamily: display,
                    fontSize: 52,
                    color: C.ink,
                    marginTop: 16,
                    lineHeight: 1.16,
                    letterSpacing: -1,
                }}
            >
                pick the cells the price has to pass through
            </div>

            <div style={{marginTop: 30}}>
                {PICKS.map((pk, i) => {
                    const placed = i < picksPlaced;
                    return (
                        <div
                            key={`${pk.t}:${pk.p}`}
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontFamily: mono,
                                fontSize: 19,
                                padding: '9px 14px',
                                marginBottom: 5,
                                background: placed ? 'rgba(73,118,255,0.13)' : 'transparent',
                                color: placed ? C.ink : C.inkFaint,
                                opacity: placed ? 1 : 0.22,
                            }}
                        >
                            <span>
                                step {pk.t + 1} · {fmtMult(multAt(pk.t, pk.p))}
                            </span>
                            <b style={{color: C.blue, fontWeight: 600}}>{STAKE_EACH.toFixed(2)} CTC</b>
                        </div>
                    );
                })}
            </div>

            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: 20,
                    paddingTop: 18,
                    borderTop: `1px solid ${C.hairlineStrong}`,
                    fontFamily: mono,
                    fontSize: 26,
                }}
            >
                <span style={{color: C.inkFaint}}>AT RISK</span>
                <b style={{color: C.ink, fontWeight: 600}}>{(picksPlaced * STAKE_EACH).toFixed(2)} CTC</b>
            </div>
        </Rail>
    );
};

/** 0:22–0:33 — the payout, counted up as the columns resolve. */
export const PayRail: React.FC<{resolvedCols: number}> = ({resolvedCols}) => {
    const frame = useCurrentFrame();
    const {fps} = useVideoConfig();
    // leaves on exactly the board's exit ramp, so the rail and the board go together
    const o = win(frame, T.payRailIn, T.payRailIn + 26, T.boardOut, T.boardOut + 30);
    const lift = interpolate(o, [0, 1], [16, 0]);

    const returned = returnedAfter(resolvedCols);
    const done = resolvedCols >= LUNA.timeSteps;
    // the last candle lands on this frame, so the pop has to be on that beat and not after it
    const lastFrame = T.revealFrom + (LUNA.lead + LUNA.timeSteps - 1) * T.revealEvery;
    const pop = spring({frame: frame - lastFrame, fps, config: {damping: 11, mass: 0.6}});
    const landed = PICKS.filter(
        (pk) => pk.t < resolvedCols && LUNA.outcome.find((oc) => oc.t === pk.t)?.p === pk.p,
    ).length;

    return (
        <Rail opacity={o} lift={lift}>
            {tag('// RESOLVING FROM PROVEN CANDLES')}
            <div style={{fontFamily: mono, fontSize: 17, letterSpacing: 1.4, color: C.inkFaint, marginTop: 30}}>
                RETURNED
            </div>
            <div
                style={{
                    fontFamily: display,
                    fontSize: 128,
                    lineHeight: 1,
                    letterSpacing: -3,
                    color: done ? C.win : C.ink,
                    fontVariantNumeric: 'tabular-nums',
                    transform: `scale(${1 + (done ? pop * 0.04 : 0)})`,
                    transformOrigin: 'left center',
                }}
            >
                {returned.toFixed(2)}
            </div>
            <div style={{fontFamily: mono, fontSize: 30, color: C.inkMute, marginTop: 6}}>CTC</div>

            <div
                style={{
                    marginTop: 40,
                    paddingTop: 22,
                    borderTop: `1px solid ${C.hairlineStrong}`,
                    fontFamily: mono,
                    fontSize: 24,
                    color: C.inkMute,
                    lineHeight: 1.9,
                }}
            >
                <div style={{display: 'flex', justifyContent: 'space-between'}}>
                    <span>staked</span>
                    <b style={{color: C.ink, fontWeight: 600}}>{TOTAL_STAKE.toFixed(2)} CTC</b>
                </div>
                <div style={{display: 'flex', justifyContent: 'space-between'}}>
                    <span>cells landed</span>
                    <b style={{color: C.ink, fontWeight: 600}}>
                        {landed} / {PICKS.length}
                    </b>
                </div>
                <div style={{display: 'flex', justifyContent: 'space-between', opacity: done ? 1 : 0.22}}>
                    <span>return</span>
                    <b style={{color: C.win, fontWeight: 600}}>{(TOTAL_RETURN / TOTAL_STAKE).toFixed(2)}×</b>
                </div>
            </div>
        </Rail>
    );
};

/** A title that sits over the board while the board is pushed back — never instead of it. */
const Title: React.FC<{opacity: number; children: React.ReactNode}> = ({opacity, children}) => {
    if (opacity <= 0) return null;
    const lift = interpolate(opacity, [0, 1], [20, 0]);
    return (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'}}>
            <div style={{textAlign: 'center', opacity, transform: `translateY(${lift}px)`}}>{children}</div>
        </AbsoluteFill>
    );
};

/** 0:11–0:15 — the rule of the game, stated once over the board it applies to. */
export const WhenTitle: React.FC = () => {
    const frame = useCurrentFrame();
    const o = win(frame, T.whenIn, T.whenIn + 22, T.whenOut, T.whenOut + 22);
    return (
        <Title opacity={o}>
            <div style={{fontFamily: display, fontSize: 82, color: C.ink, letterSpacing: -1}}>
                you are never told <i style={{color: C.blue, fontStyle: 'normal'}}>when</i> this is
            </div>
            <div
                style={{
                    fontFamily: sans,
                    fontSize: 30,
                    color: C.inkMute,
                    marginTop: 26,
                    opacity: rampIn(frame, T.whenIn + 34, T.whenIn + 54),
                }}
            >
                that is the whole game
            </div>
        </Title>
    );
};

/**
 * 0:29–0:33 — the answer.
 *
 * The date is withheld for twenty-nine seconds and then given plainly. The second line is the
 * point of the whole video, so it arrives on its own beat: the people who called it here were
 * looking at exactly this chart.
 */
export const EraTitle: React.FC = () => {
    const frame = useCurrentFrame();
    const o = win(frame, T.eraIn, T.eraIn + 24, T.boardOut, T.boardOut + 30);
    return (
        <Title opacity={o}>
            <div style={{fontFamily: mono, fontSize: 20, letterSpacing: 3, color: C.inkFaint}}>// THE ANSWER</div>
            <div style={{fontFamily: display, fontSize: 104, color: C.ink, letterSpacing: -2, marginTop: 18}}>
                this was May 2022.
            </div>
            <div
                style={{
                    fontFamily: sans,
                    fontSize: 38,
                    color: C.inkMute,
                    marginTop: 34,
                    opacity: rampIn(frame, T.eraIn + 44, T.eraIn + 66),
                }}
            >
                plenty of people called the bottom here too.
            </div>
            <div
                style={{
                    fontFamily: mono,
                    fontSize: 21,
                    letterSpacing: 1.6,
                    color: C.inkFaint,
                    marginTop: 44,
                    opacity: rampIn(frame, T.eraIn + 72, T.eraIn + 94),
                }}
            >
                block {LUNA.firstBlock.toLocaleString('en-US')} · {LUNA.pool}
            </div>
        </Title>
    );
};
