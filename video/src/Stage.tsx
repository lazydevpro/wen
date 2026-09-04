import React from 'react';
import {C, cut} from './brand';
import {LUNA} from './data/luna';
import {Chart, REVEALED, VISIBLE} from './Board';
import {Grid} from './Grid';
import {mono} from './fonts';

export const BOARD = {x: 660, y: 150, w: 1170, h: 780, pad: 26, head: 56};
export const CHART_W = BOARD.w - BOARD.pad * 2;
export const CHART_H = BOARD.h - BOARD.pad * 2 - BOARD.head;
export const RAIL = {x: 92, y: 168, w: 512};

/**
 * A cut-corner panel, drawn as two stacked layers: the outer one paints the border colour and the
 * inner one paints the fill inset by a pixel. A single clipped element cannot show a border on its
 * diagonal edges — the clip cuts the border off along with the box.
 */
export const Panel: React.FC<{
    style?: React.CSSProperties;
    cutPx?: number;
    border?: string;
    fill?: string;
    children?: React.ReactNode;
}> = ({style, cutPx = 18, border = C.hairline, fill = C.panel, children}) => (
    <div style={{...style, background: border, clipPath: cut(cutPx)}}>
        <div style={{width: '100%', height: '100%', background: fill, clipPath: cut(cutPx - 1), boxSizing: 'border-box'}}>
            {children}
        </div>
    </div>
);

/**
 * The board: chart, grid, and the price readout above them.
 *
 * Mounted exactly once for the whole middle of the video and never torn down. The riddle, the
 * betting, the reveal and the answer all happen to this same board while it sits there — that
 * continuity is the reason the middle thirty seconds read as one shot rather than five clips.
 * Everything that changes between beats is a prop.
 */
export const BoardPanel: React.FC<{
    revealCount?: number;
    gridAppear?: number;
    picksPlaced?: number;
    resolvedCols?: number;
    /** 0 = fully present, 1 = pushed back so a title can sit on top */
    dim?: number;
    /** 0..1 arrival — fades and settles the board into place */
    enter?: number;
}> = ({revealCount = 0, gridAppear = 0, picksPlaced = 0, resolvedCols = 0, dim = 0, enter = 1}) => {
    const shown = REVEALED.slice(0, revealCount);
    const price = shown.length ? shown[shown.length - 1] : VISIBLE[VISIBLE.length - 1];

    return (
        <Panel
            style={{
                position: 'absolute',
                left: BOARD.x,
                top: BOARD.y,
                width: BOARD.w,
                height: BOARD.h,
                opacity: enter * (1 - dim * 0.84),
                // arrives by settling forward rather than appearing; recedes slightly when dimmed
                transform: `scale(${0.985 + enter * 0.015 - dim * 0.012})`,
                transformOrigin: 'center',
            }}
        >
            <div style={{padding: BOARD.pad}}>
                <div
                    style={{
                        height: BOARD.head - 14,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-end',
                        marginBottom: 14,
                    }}
                >
                    <div>
                        <div style={{fontFamily: mono, fontSize: 13, letterSpacing: 1.4, color: C.inkFaint}}>LAST PRICE</div>
                        <div style={{fontFamily: mono, fontSize: 34, fontWeight: 600, color: C.ink}}>
                            ${price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                        </div>
                    </div>
                    <div style={{fontFamily: mono, fontSize: 13, letterSpacing: 1.4, color: C.inkFaint, textAlign: 'right'}}>
                        {LUNA.pool}
                        <br />
                        UNISWAP V3 · ETHEREUM
                    </div>
                </div>

                <div style={{position: 'relative', width: CHART_W, height: CHART_H}}>
                    <Chart width={CHART_W} height={CHART_H} revealCount={revealCount} />
                    {gridAppear > 0 ? (
                        <Grid
                            width={CHART_W}
                            height={CHART_H}
                            appear={gridAppear}
                            picksPlaced={picksPlaced}
                            resolvedCols={resolvedCols}
                        />
                    ) : null}
                </div>
            </div>
        </Panel>
    );
};

/**
 * A rail layer. Three of these share the same corner of the screen and hand over to each other by
 * fading and lifting, so the rail changes contents without the frame ever cutting.
 */
export const Rail: React.FC<{opacity: number; lift?: number; children: React.ReactNode}> = ({
    opacity,
    lift = 0,
    children,
}) => {
    if (opacity <= 0) return null;
    return (
        <div
            style={{
                position: 'absolute',
                left: RAIL.x,
                top: RAIL.y,
                width: RAIL.w,
                opacity,
                transform: `translateY(${lift}px)`,
            }}
        >
            {children}
        </div>
    );
};
