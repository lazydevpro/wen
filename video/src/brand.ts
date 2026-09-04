/**
 * The same tokens the game ships with, so the video and the product cannot drift apart.
 * Mirrors :root in web/styles.css — if that changes, change this.
 */
export const C = {
    canvas: '#0c0e10',
    panel: '#111417',
    ink: '#f0efee',
    inkMute: '#aaacae',
    inkFaint: '#6e7073',
    hairline: '#1f2428',
    hairlineStrong: '#2a3440',
    blue: '#4976ff',
    blueEdge: 'rgba(73, 118, 255, 0.42)',
    win: '#2fd07a',
    lose: '#ff4d4d',
} as const;

export const FPS = 30;
export const W = 1920;
export const H = 1080;

/** The cut-corner used on every panel in the game. */
export const cut = (px: number) =>
    `polygon(0 0, calc(100% - ${px}px) 0, 100% ${px}px, 100% 100%, ${px}px 100%, 0 calc(100% - ${px}px))`;
