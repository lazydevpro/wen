import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {C} from './brand';

/**
 * The app icon's arrow, drawing itself — the same gesture the real chart makes when a round plays
 * forward, so the video moves the way the product does.
 *
 * The head is a marker-end on the path's last vertex: orient="auto" rotates it to the final
 * segment, so it stays correct without a per-shape transform. Its fill is `context-stroke` and the
 * line's stroke is an explicit colour, never currentColor — a currentColor token re-resolves
 * inside the marker's own context and paints the head the wrong colour.
 */
export const WenMark: React.FC<{
    /** frame the draw begins on */
    from?: number;
    /** frames the draw takes */
    duration?: number;
    color?: string;
    width?: number;
    strokeWidth?: number;
    id?: string;
}> = ({from = 0, duration = 26, color = C.blue, width = 320, strokeWidth = 9, id = 'head'}) => {
    const frame = useCurrentFrame();
    const t = interpolate(frame, [from, from + duration], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    // ease-out so it snaps away and settles, rather than crawling at a constant rate
    const eased = 1 - Math.pow(1 - t, 3);
    // the head only exists once the line has arrived
    const headOpacity = interpolate(t, [0.82, 0.95], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });

    return (
        <svg viewBox="0 0 132 84" width={width} height={(width * 84) / 132} style={{overflow: 'visible'}}>
            <defs>
                <marker
                    id={id}
                    viewBox="0 0 10 10"
                    refX="3.4"
                    refY="5"
                    markerWidth="3.1"
                    markerHeight="3.1"
                    orient="auto"
                    markerUnits="strokeWidth"
                >
                    <path d="M0.6 0.9 L9.4 5 L0.6 9.1 L2.6 5 Z" fill="context-stroke" opacity={headOpacity} />
                </marker>
            </defs>
            <path
                d="M12 54 L36 72 L60 30 L86 60 L112 26"
                pathLength={100}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={100}
                strokeDashoffset={100 - eased * 100}
                markerEnd={`url(#${id})`}
            />
        </svg>
    );
};
