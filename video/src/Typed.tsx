import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C} from './brand';

/**
 * Types a string out on a frame budget, with a blinking caret.
 *
 * Deliberately not a <Sequence>: Sequence wraps its children in an AbsoluteFill, which would rip
 * each line out of the column flow and stack them all in the corner. `from` is an absolute frame
 * within the enclosing sequence.
 */
export const Typed: React.FC<{
    text: string;
    from: number;
    /** frames per character */
    per?: number;
    size: number;
    color?: string;
    font: string;
    lineHeight?: number;
    letterSpacing?: number;
    /** frame the caret retires on — one caret on screen at a time, or it reads as two cursors */
    caretUntil?: number;
}> = ({text, from, per = 1.6, size, color = C.ink, font, lineHeight = 1.15, letterSpacing = -1, caretUntil = Infinity}) => {
    const frame = useCurrentFrame();
    // nothing at all before the line's turn — otherwise a bare caret sits on screen from frame 0
    if (frame < from) return null;

    const shown = Math.min(text.length, Math.floor((frame - from) / per));
    const done = shown >= text.length;
    const caretOn = frame < caretUntil && Math.floor(frame / 8) % 2 === 0;

    return (
        <div style={{fontFamily: font, fontSize: size, color, letterSpacing, lineHeight}}>
            {text.slice(0, shown)}
            <span
                style={{
                    display: 'inline-block',
                    width: size * 0.055,
                    height: size * 0.86,
                    background: C.blue,
                    marginLeft: size * 0.07,
                    verticalAlign: 'baseline',
                    // solid while typing, blinking once the line has landed, gone once it hands off
                    opacity: frame >= caretUntil ? 0 : done ? (caretOn ? 1 : 0) : 1,
                }}
            />
        </div>
    );
};
