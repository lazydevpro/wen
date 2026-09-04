import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, cut} from './brand';
import {display, mono, sans} from './fonts';
import {T, rampIn, win} from './timeline';

const TARGET = 4706;

/**
 * 0:34–0:37 — the proof.
 *
 * The number is the claim, so it counts rather than appearing: a figure that ticks up reads as
 * measured, one that cuts in reads as marketing. It settles slightly before the caption so the
 * viewer has the number before being told what it means.
 *
 * 4,706 is every candle in the deck, and each is a real Uniswap V3 swap proven onto Creditcoin.
 * Verifiable with one call to ChartVerifier — which is the whole point of showing it.
 */
export const Counter: React.FC = () => {
    const frame = useCurrentFrame();
    const {fps} = useVideoConfig();

    const present = win(frame, T.counterIn, T.counterIn + 26, T.counterOut, T.counterOut + 26);
    if (present <= 0) return null;

    const f = frame - T.counterIn;
    // ease-out: fast at the start, decelerating into the true value
    const t = interpolate(f, [4, 58], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    const value = Math.round(TARGET * (1 - Math.pow(1 - t, 3)));

    const pop = spring({frame: f - 54, fps, config: {damping: 12, mass: 0.5}});
    // arrives by settling forward, matching the board it replaces
    const scale = 0.985 + present * 0.015 + pop * 0.03;

    return (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: present}}>
            <div
                style={{
                    padding: '58px 86px',
                    background: C.panel,
                    clipPath: cut(26),
                    borderLeft: `3px solid ${C.blue}`,
                    textAlign: 'center',
                    transform: `scale(${scale})`,
                }}
            >
                <div
                    style={{
                        fontFamily: mono,
                        fontSize: 20,
                        letterSpacing: 3,
                        textTransform: 'uppercase',
                        color: C.inkFaint,
                        marginBottom: 16,
                    }}
                >
                    // candles proven on-chain
                </div>
                <div
                    style={{
                        fontFamily: display,
                        fontSize: 190,
                        color: C.ink,
                        lineHeight: 1,
                        letterSpacing: -4,
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {value.toLocaleString('en-US')}
                </div>
            </div>

            <div style={{fontFamily: sans, fontSize: 40, color: C.ink, marginTop: 46, opacity: rampIn(f, 60, 74)}}>
                every one a real Uniswap swap
            </div>
            <div style={{fontFamily: sans, fontSize: 29, color: C.inkMute, marginTop: 14, opacity: rampIn(f, 74, 88)}}>
                a chart of invented history cannot be registered
            </div>
        </AbsoluteFill>
    );
};
