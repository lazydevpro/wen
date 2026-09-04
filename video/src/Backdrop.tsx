import React from 'react';
import {AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame} from 'remotion';
import {C} from './brand';
import {DURATION} from './timeline';

/**
 * The game's own backdrop, drifting for the whole video.
 *
 * Rendered once at the root and never inside a <Sequence> — a Sequence restarts useCurrentFrame()
 * at zero, so the drift would snap back to the beginning at every beat and hand the viewer a cut
 * cue the edit is trying not to give. One continuous drift is most of what makes 42 seconds of
 * separate ideas feel like one shot.
 *
 * Masked at the edges for the same reason it is in the app: a hard edge against the frame reads as
 * a pasted-on texture.
 */
export const Backdrop: React.FC<{opacity?: number}> = ({opacity = 0.3}) => {
    const frame = useCurrentFrame();
    const scale = interpolate(frame, [0, DURATION], [1.05, 1.16], {extrapolateRight: 'clamp'});

    return (
        <AbsoluteFill style={{backgroundColor: C.canvas}}>
            <AbsoluteFill
                style={{
                    opacity,
                    maskImage: 'radial-gradient(ellipse 120% 100% at 50% 45%, #000 30%, transparent 100%)',
                    WebkitMaskImage: 'radial-gradient(ellipse 120% 100% at 50% 45%, #000 30%, transparent 100%)',
                }}
            >
                <Img
                    src={staticFile('bg-texture.jpg')}
                    style={{width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale})`}}
                />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
