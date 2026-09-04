import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {C} from './brand';
import {WenMark} from './WenMark';
import {Typed} from './Typed';
import {display, mono} from './fonts';
import {T, win} from './timeline';

/**
 * 0:00–0:04 — the hook.
 *
 * Two lines, and the video lives or dies on them being read in the first two seconds, so nothing
 * else moves while they land. The arrow draws only after "prove it." is on screen: the challenge
 * first, the brand second.
 *
 * Runs on the absolute frame and leaves on a ramp that overlaps the board's arrival, so the hook
 * dissolves into the game rather than cutting to it.
 */
export const Opening: React.FC = () => {
    const frame = useCurrentFrame();
    const leaving = win(frame, T.openIn, T.openIn + 1, T.openOut, T.openOut + 34);
    if (leaving <= 0) return null;

    // the boast recedes as the challenge arrives, so the eye is never asked to hold both
    const line1 = interpolate(frame, [0, 6, 62, 74], [0, 1, 1, 0.3], {extrapolateRight: 'clamp'});
    // drifts left on the way out, so the board seems to push it off screen
    const drift = interpolate(leaving, [0, 1], [-40, 0]);

    return (
        <AbsoluteFill style={{opacity: leaving, transform: `translateX(${drift}px)`}}>
            <AbsoluteFill style={{justifyContent: 'center', paddingLeft: 190, paddingRight: 120}}>
                <div style={{opacity: line1}}>
                    <Typed text="everyone called the bottom." from={4} size={86} color={C.inkMute} font={display} caretUntil={66} />
                </div>

                <div style={{marginTop: 30, minHeight: 190}}>
                    <Typed text="prove it." from={66} per={2.6} size={148} font={display} caretUntil={T.openOut} />
                    <div style={{marginTop: 30}}>
                        <WenMark from={102} duration={22} width={300} id="openHead" />
                    </div>
                </div>
            </AbsoluteFill>

            <div
                style={{
                    position: 'absolute',
                    bottom: 66,
                    left: 190,
                    fontFamily: mono,
                    fontSize: 22,
                    letterSpacing: 2,
                    color: C.inkFaint,
                    opacity: interpolate(frame, [116, 132], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
                }}
            >
                // wen
            </div>
        </AbsoluteFill>
    );
};
