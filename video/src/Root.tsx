import React from 'react';
import {Composition} from 'remotion';
import {FPS, W, H} from './brand';
import {Full} from './Full';
import {DURATION} from './timeline';

/**
 * One composition, because the video is one continuous timeline — beats overlap and share a board,
 * so they cannot be rendered independently and stitched.
 *
 * To iterate on a single beat, render a frame range instead:
 *   npx remotion render Full out/beat.mp4 --frames=660-900
 */
export const RemotionRoot: React.FC = () => (
    <Composition id="Full" component={Full} durationInFrames={DURATION} fps={FPS} width={W} height={H} />
);
