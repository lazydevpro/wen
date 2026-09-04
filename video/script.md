# Voiceover script — wen launch video

42.0s. Timings are against `out/wen-launch.mp4` as rendered.

**The source of truth is `vo/lines.json`** — the merge script reads it. This file is the readable
version; if you change a line, change it there too.

## The script

| # | in | budget | line | on screen |
|---|---|---|---|---|
| 01 | 0:00.3 | 1.9s | Everyone called the bottom. | same line typing |
| 02 | 0:02.4 | 2.3s | Prove it. | same line typing |
| 03 | 0:04.9 | 3.5s | Every round is a real slice of Ethereum history. | board arrives |
| 04 | 0:08.6 | 3.1s | The riddle is your only clue to when. | riddle fully typed |
| 05 | 0:11.9 | 3.2s | You're never told when this is. | same line as title |
| 06 | 0:15.3 | 2.5s | Now bet on where it goes next. | grid deals in |
| 07 | 0:18.0 | 4.5s | Pick the cells it has to pass through. Further out pays more. | picks landing |
| 08 | 0:22.7 | 2.3s | Then the history plays forward. | payout rail arrives |
| 09 | 0:25.2 | 4.3s | Not a simulation. Every candle is a real Uniswap swap. | cells resolving |
| 10 | 0:29.7 | 4.4s | May 2022. People called the bottom here too. | `this was May 2022.` |
| 11 | 0:34.3 | 3.7s | And every one of them, proven on Creditcoin. | `4,706` |
| 12 | 0:38.2 | 3.6s | wen. Bet on what already happened. wenctc dot fun. | end card |

About 30 seconds of speech in 42, so roughly a quarter of it is silence, and every line has at
least a half-second of air in front of it. That is deliberate — the gaps are where the chart moves.

Line 11 does **not** read the number out. `4,706` is already on screen in 190px type; saying it
takes two seconds the payoff needs more.

## Delivery

Dry and certain, not hyped. The video is making a verifiable claim, and an excited read makes a
true claim sound like a false one. Documentary narrator, not trailer voice.

- **01 and 02** are slower than everything else. 02 lands flat — no upward inflection.
- **05 and 10** are the two thesis beats. Slow down; let each sit.
- **09** carries the proof. Hit *real*.
- **10**: read the year as "May twenty twenty-two".
- **12**: "wen" is a word, not W-E-N. The domain is "wen C T C dot fun".
- Lines 03–08 can run brisk. The visuals are doing the work there.

Three lines (01, 02, 05) deliberately say what is on screen at the same moment. That is unison for
emphasis, not duplication — keep it.

## Generating it with OpenAI TTS

```bash
npm run tts            # all twelve lines → vo/01…12.wav
npm run merge          # → out/wen-launch-vo.mp4
```

Needs `OPENAI_API_KEY` in the environment, or an `OPENAI_API_KEY=` line in `video/.env` (already
gitignored). Model is `gpt-4o-mini-tts`; roughly 30 seconds of audio, so a fraction of a cent.

The reason to use this model rather than a plain TTS is the `instructions` field: each line's
delivery note from `lines.json` is sent with it, so "flat challenge, no upward inflection" actually
reaches the voice. The house tone — dry, documentary, no salesmanship — is prepended to all twelve.

Pick a voice by ear first:

```bash
node scripts/tts.js --sample                  # every voice reading lines 02 and 09 → vo/sample/
node scripts/tts.js --voice ash               # then generate with the one you liked
node scripts/tts.js --only 09,10              # regenerate individual lines
```

Voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar.
Default is `onyx`. Line 02 is in the sampler because "Prove it." is the hardest read in the
script — a voice that lands it flat can do the rest.

Any line that comes back longer than its budget is automatically re-requested at a proportionally
higher speed, up to 1.3×, because an overrunning line talks over the next visual beat. `--no-fit`
turns that off.

## One continuous take

`vo/continuous.txt` is the whole thing as a single block, ready to paste into a TTS tool or read
straight through. The `<break>` tags are the gaps above; strip them if your tool ignores SSML and
just pause instead.

```
Everyone called the bottom.
<break time="0.6s" />
Prove it.
<break time="2.0s" />
Every round is a real slice of Ethereum history.
<break time="0.6s" />
The riddle is your only clue to when.
<break time="1.2s" />
You're never told when this is.
<break time="1.5s" />
Now bet on where it goes next.
<break time="0.7s" />
Pick the cells it has to pass through. Further out pays more.
<break time="1.3s" />
Then the history plays forward.
<break time="0.8s" />
Not a simulation. Every candle is a real Uniswap swap.
<break time="0.6s" />
May 2022. People called the bottom here too.
<break time="0.8s" />
And every one of them, proven on Creditcoin.
<break time="0.9s" />
wen. Bet on what already happened. wenctc dot fun.
```

Save the result as `vo/take.wav` (or mp3) and merge it with alignment:

```bash
node scripts/merge-audio.js --single vo/take.wav --align
```

**`--align` re-syncs the take to the picture**, so the pause lengths above do not have to be
exact and the total does not have to be 42s. It finds the twelve spoken spans and moves each to
its target start, which means drift cannot accumulate down the take. The only thing it needs is a
**clear pause between lines that is longer than any pause inside a line** — it keeps the eleven
widest gaps as the boundaries, so a beat after "Not a simulation." is fine as long as the beat
before "May 2022." is longer.

Tested against a deliberately mistimed 42.9s take with flat one-second pauses read slow: by the
last line it had drifted 1.3s late, and alignment put all twelve back on their marks exactly.

Without `--align` the take is laid down from 0:00 as recorded, and the timings above have to be
right.

## Twelve separate clips

More control, no reliance on gap detection. Record one clip per line, named by id:

```
vo/01.wav  vo/02.wav  …  vo/12.wav
```

WAV or MP3, mono or stereo, any sample rate. Do **not** try to time them to the video — the merge
script places each clip at its exact start, so per-clip placement is always accurate and timing
drift cannot accumulate. Just trim leading silence so each clip starts on the first word.

Keep each clip at or under its budget. The merge script prints the measured length of every clip
against its budget and warns when one will bleed into the next beat.

```bash
npm run merge
```

## Merging

Either route writes `out/wen-launch-vo.mp4` and leaves the silent cut untouched. The video stream
is copied, never re-encoded, so merging costs no quality.

```bash
npm run merge                                                # twelve clips in vo/01…12
node scripts/merge-audio.js --single vo/take.wav --align     # one take, re-synced
node scripts/merge-audio.js --single vo/take.wav             # one take, as recorded
node scripts/merge-audio.js --music vo/bed.mp3               # add a music bed
node scripts/merge-audio.js --music vo/bed.mp3 --music-gain 0.12
```

`--music` combines with either voiceover route.

## Music

Optional, and the video does not need it. If you add a bed: sparse and tense, no melodic hook
competing with the read, well under the voice. The merge script defaults to 0.18 gain and fades
out over the last 1.2s.

Whatever you pick must be cleared for commercial use — a copyright claim on the launch post is a
bad first impression, and Twitter's audio matching does catch library tracks.

## Note

The video is designed to be legible with no sound at all, because Twitter autoplays muted. The
voiceover is a bonus for anyone who unmutes; it must never become load-bearing. Nothing in the
script above states a fact the screen does not already carry.
