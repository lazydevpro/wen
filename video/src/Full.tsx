import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {C} from './brand';
import {LUNA} from './data/luna';
import {Backdrop} from './Backdrop';
import {BoardPanel} from './Stage';
import {Opening} from './Opening';
import {Counter} from './Counter';
import {EndCard} from './EndCard';
import {RiddleRail, BetRail, PayRail, WhenTitle, EraTitle} from './Scenes';
import {PICKS} from './Grid';
import {T, ease, rampIn, win} from './timeline';

/**
 * The whole video as one continuous timeline.
 *
 * There are deliberately no <Sequence>s here. A Sequence mounts its child at its start frame and
 * unmounts it at the end, which is a cut — and eight of them in a row is eight cuts, which is what
 * made the first pass feel like separate clips shoved together. Instead every element reads the
 * absolute frame and fades itself in and out over a window, and the windows overlap.
 *
 * Two things are on screen for the whole middle of the video and never restart: the drifting
 * backdrop, and the board itself. The riddle, the betting, the reveal and the answer all happen to
 * that same board while it sits there. That is what makes thirty seconds of separate ideas read as
 * one shot.
 */
export const Full: React.FC = () => {
    const frame = useCurrentFrame();

    // ── board state, all derived from one clock ──────────────────────
    const enter = ease(rampIn(frame, T.boardIn, T.boardIn + 34));
    const leave = 1 - rampIn(frame, T.boardOut, T.boardOut + 30);
    const gridAppear = ease(rampIn(frame, T.gridIn, T.gridIn + 62));

    const picksPlaced = Math.max(
        0,
        Math.min(PICKS.length, Math.floor((frame - T.picksFrom) / T.picksEvery) + 1),
    );

    const maxReveal = LUNA.lead + LUNA.timeSteps;
    const revealCount = Math.max(
        0,
        Math.min(maxReveal, Math.floor((frame - T.revealFrom) / T.revealEvery) + 1),
    );
    // the first LEAD candles are runway: travelled, never bet on, so they resolve nothing
    const resolvedCols = Math.max(0, revealCount - LUNA.lead);

    // The board recedes under a title rather than being replaced by one. The era dim never ramps
    // back down — releasing it would brighten the board on its way out, which reads as a flash.
    const dim = Math.max(
        win(frame, T.whenIn, T.whenIn + 22, T.whenOut, T.whenOut + 22),
        rampIn(frame, T.eraIn, T.eraIn + 24),
    );

    return (
        <AbsoluteFill style={{background: C.canvas}}>
            {/* one backdrop, one continuous drift, never re-mounted */}
            <Backdrop />

            {/* the hook, dissolving into the board */}
            <Opening />

            {/* the board: mounted once, alive from 0:04 to 0:33 */}
            {enter > 0 && leave > 0 ? (
                <AbsoluteFill style={{opacity: leave}}>
                    <BoardPanel
                        enter={enter}
                        dim={dim}
                        gridAppear={gridAppear}
                        picksPlaced={picksPlaced}
                        resolvedCols={resolvedCols}
                        revealCount={revealCount}
                    />
                    <RiddleRail />
                    <BetRail picksPlaced={picksPlaced} />
                    <PayRail resolvedCols={resolvedCols} />
                    <WhenTitle />
                    <EraTitle />
                </AbsoluteFill>
            ) : null}

            <Counter />
            <EndCard />
        </AbsoluteFill>
    );
};
