import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from './brand';
import {WenMark} from './WenMark';
import {display, mono} from './fonts';
import {T, rampIn} from './timeline';

/**
 * Change this the day the domain resolves — until then render with SHOW_DOMAIN false and put the
 * link in the tweet instead. A dead URL on the end card is worse than no URL.
 */
const DOMAIN = 'wenctc.fun';
const SHOW_DOMAIN = true;

/**
 * 0:38–0:42 — the end card.
 *
 * One mark, one name, one address. Everything else the viewer needs is in the tweet, and a card
 * that asks to be read twice gets read zero times.
 */
export const EndCard: React.FC = () => {
    const frame = useCurrentFrame();
    const {fps} = useVideoConfig();

    const present = rampIn(frame, T.endIn, T.endIn + 26);
    if (present <= 0) return null;

    const f = frame - T.endIn;
    const rise = spring({frame: f - 14, fps, config: {damping: 200}});
    const wordY = interpolate(rise, [0, 1], [18, 0]);

    return (
        <AbsoluteFill style={{opacity: present}}>
            <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
                <WenMark from={T.endIn + 2} duration={20} width={280} id="endHead" />

                <div
                    style={{
                        fontFamily: display,
                        fontSize: 168,
                        color: C.ink,
                        letterSpacing: -2,
                        lineHeight: 1,
                        marginTop: 22,
                        opacity: rise,
                        transform: `translateY(${wordY}px)`,
                    }}
                >
                    wen
                </div>

                <div style={{fontFamily: mono, fontSize: 30, letterSpacing: 2, color: C.inkMute, marginTop: 26, opacity: rise}}>
                    bet on what already happened
                </div>

                {SHOW_DOMAIN ? (
                    <div style={{fontFamily: display, fontSize: 52, color: C.blue, marginTop: 54, opacity: rampIn(f, 42, 58)}}>
                        {DOMAIN}
                    </div>
                ) : null}
            </AbsoluteFill>

            <div
                style={{
                    position: 'absolute',
                    bottom: 62,
                    width: '100%',
                    textAlign: 'center',
                    fontFamily: mono,
                    fontSize: 21,
                    letterSpacing: 2,
                    color: C.inkFaint,
                    opacity: rampIn(f, 56, 72),
                }}
            >
                proven on creditcoin // attestcoin protocol
            </div>
        </AbsoluteFill>
    );
};
