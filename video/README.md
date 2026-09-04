# Launch video

A complete 42-second launch video, rendered end to end. No screen capture, no external assets.

```bash
npm install
npm run studio          # preview and scrub
npm run render          # → out/wen-launch.mp4  (42s, 1920×1080)
npm run poster          # → out/poster-hook.png, out/poster-payout.png
```

Frame 0 is nearly black, so let the poster be the upload thumbnail rather than the auto-picked
first frame — `poster-hook.png` is `prove it.`, `poster-payout.png` is the resolved board without
giving the date away.

## Beats

| in | on screen |
|---|---|
| 0:00 | `everyone called the bottom.` → `prove it.` |
| 0:05 | the Luna riddle types in beside eight real candles |
| 0:11 | `you are never told when this is` |
| 0:15 | the grid deals in, eight picks land |
| 0:22 | the path walks forward, cells resolve, payout counts up |
| 0:29 | `this was May 2022.` |
| 0:34 | `4,706` candles, every one a real Uniswap swap |
| 0:38 | wordmark, `wenctc.fun` |

## It is one shot, not eight clips

There are no `<Sequence>`s in this project, and that is deliberate. A Sequence mounts its child at
a start frame and unmounts it at the end — which is a cut, and eight in a row read as eight
separate videos stitched together.

Instead every element reads the **absolute** frame and fades itself in and out over a window, and
the windows overlap. All of them live in one table in `src/timeline.ts`; `win(frame, a, b, c, d)`
is the entire transition vocabulary.

Two things are on screen for the whole middle of the video and never re-mount:

- the **backdrop**, drifting continuously for all 1,260 frames (inside a Sequence its clock would
  restart at every beat, handing the viewer a cut cue)
- the **board** itself — the riddle, the betting, the reveal and the answer all happen to that same
  board while it sits there. Titles dim it and sit on top; they never replace it.

Because beats share a board and overlap, they cannot be rendered separately and stitched. To
iterate on one, render a frame range:

```bash
npx remotion render Full out/beat.mp4 --frames=660-900
```

## Voiceover

`script.md` has the twelve-line VO script with timings; `vo/lines.json` is the machine-readable
version the merge script reads. Record one clip per line into `vo/01…12`, then:

```bash
npm run merge          # → out/wen-launch-vo.mp4
```

Each clip is placed at its exact start time rather than concatenated, so timing drift cannot
accumulate, and the merge prints every clip's length against its budget. The video is designed to
work with no sound at all — Twitter autoplays muted — so the VO is a bonus, never load-bearing.

## The numbers are real

`src/data/luna.ts` is lifted verbatim from `worker/data/windows/luna-2022.json` by
`scripts/bake-window.js` — the same window the game deals and the same candles proven on-chain.
The candles, the grid multipliers, and which cells land are all read from it. The payout in the
`Reveal` beat is arithmetic on that data, not a number chosen to look good:

- 8 picks × 1.00 CTC = **8.00 CTC** staked
- 5 land: 7.10 + 3.90 + 8.60 + 8.20 + 12.10 = **39.90 CTC** returned → **4.99×**

Five of eight is a lucky round. The video is showing the upside, not a typical result — worth
remembering if anyone asks.

Re-bake after regenerating the window pool, or to feature a different era:

```bash
node scripts/bake-window.js luna-2022
```

## Before posting

- `wenctc.fun` must resolve, or set `SHOW_DOMAIN = false` in `src/EndCard.tsx` and put the link in
  the tweet instead. A dead URL on the end card is worse than no URL.
- `TARGET` in `src/Counter.tsx` is the deck's candle count. If the deck grows, re-read it from
  `ChartVerifier` and update the constant — the number is the claim.
- The video is silent by design. Twitter autoplays muted, and every beat is legible without sound.

## Notes

- `src/brand.ts` mirrors `:root` in `web/styles.css`. Change one, change the other.
- `src/Board.tsx` mirrors `drawChart()` and `layoutGrid()` in `web/app.js` — the two-step runway
  before the grid starts is the real `GRID_LEAD_STEPS`, so cells sit under the line they describe.
- `src/fonts.ts` pins weights and subset. Unpinned, `loadFont()` fetches every weight and subset,
  which is slow over 1,260 frames and drops requests mid-render.
- `Typed` is deliberately not a `<Sequence>`: Sequence wraps children in an `AbsoluteFill`, which
  pulls each line out of the column flow and stacks them in the corner.
