/**
 * Mixes the recorded voiceover (and optionally a music bed) onto the rendered video.
 *
 *   node scripts/merge-audio.js                              # twelve clips: vo/01…12
 *   node scripts/merge-audio.js --single vo/take.wav --align # one take, re-synced to the picture
 *   node scripts/merge-audio.js --single vo/take.wav         # one take, laid down as recorded
 *   node scripts/merge-audio.js --music vo/bed.mp3 --music-gain 0.12
 *
 * Whichever route, every line ends up placed at its exact start time from vo/lines.json rather
 * than concatenated, so a line running long or short cannot push everything after it out of sync.
 * The video stream is copied, never re-encoded — merging audio must not cost a generation.
 */
const fs = require('fs');
const path = require('path');
const {execFileSync, spawnSync} = require('child_process');

const root = path.join(__dirname, '..');
const VO_DIR = path.join(root, 'vo');
const SRC = path.join(root, 'out', 'wen-launch.mp4');
const DEST = path.join(root, 'out', 'wen-launch-vo.mp4');

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(name);
const music = flag('--music');
const musicGain = Number(flag('--music-gain') ?? 0.18);
const single = flag('--single');
const align = has('--align');

if (!fs.existsSync(SRC)) {
    console.error(`No render at ${path.relative(root, SRC)} — run \`npm run render\` first.`);
    process.exit(1);
}

const {duration, lines} = JSON.parse(fs.readFileSync(path.join(VO_DIR, 'lines.json'), 'utf8'));

/** Seconds of audio kept either side of a detected span, so soft consonants survive the cut. */
const PAD = 0.06;

/** Seconds of audio in a file, via ffprobe. */
const durationOf = (file) =>
    Number(
        execFileSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file,
        ]).toString().trim(),
    );

/** First existing file among the accepted extensions for a clip id. */
const findClip = (id) => {
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg']) {
        const p = path.join(VO_DIR, `${id}.${ext}`);
        if (fs.existsSync(p)) return p;
    }
    return null;
};

/**
 * Splits a continuous take into one span per spoken line.
 *
 * Silence detection alone over-segments — a reader pauses inside a line as well as between them,
 * so "Not a simulation. Every candle…" reads as two spans. Rather than demand a threshold that
 * happens to separate the two, take every candidate boundary and keep only the widest gaps, as
 * many as there are joins between lines. That only needs the pauses between lines to be *longer*
 * than the pauses inside them, which is how anyone reads anyway.
 */
const splitTake = (file, count) => {
    const total = durationOf(file);
    // silencedetect reports on stderr, so this cannot use execFileSync (which returns stdout)
    const out = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.18', '-f', 'null', '-'],
        {encoding: 'utf8'},
    ).stderr;

    const silences = [];
    let open = null;
    for (const line of out.split('\n')) {
        const s = line.match(/silence_start:\s*([\d.]+)/);
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (s) open = Number(s[1]);
        else if (e) {
            silences.push({start: open ?? 0, end: Number(e[1])});
            open = null;
        }
    }
    if (open !== null) silences.push({start: open, end: total});

    // speech = whatever the silences leave behind
    let spans = [];
    let cursor = 0;
    for (const sil of silences) {
        if (sil.start > cursor + 0.05) spans.push({start: cursor, end: sil.start});
        cursor = Math.max(cursor, sil.end);
    }
    if (cursor < total - 0.05) spans.push({start: cursor, end: total});
    spans = spans.filter((s) => s.end - s.start > 0.12);

    if (spans.length < count) return {spans, total, ok: false};

    // merge across the narrowest gaps until only the line boundaries are left
    while (spans.length > count) {
        let at = 0;
        let narrowest = Infinity;
        for (let i = 0; i < spans.length - 1; i += 1) {
            const gap = spans[i + 1].start - spans[i].end;
            if (gap < narrowest) {
                narrowest = gap;
                at = i;
            }
        }
        spans[at] = {start: spans[at].start, end: spans[at + 1].end};
        spans.splice(at + 1, 1);
    }
    return {spans, total, ok: true};
};

// ── build the input list and filter graph ────────────────────────────
const inputs = [SRC];
const parts = [];

if (single) {
    if (!fs.existsSync(single)) {
        console.error(`--single file not found: ${single}`);
        process.exit(1);
    }
    const idx = inputs.length;
    inputs.push(single);

    if (align) {
        const {spans, total, ok} = splitTake(single, lines.length);
        if (!ok) {
            console.error(
                `\nFound only ${spans.length} spoken spans in ${path.relative(root, single)}, `
                + `need ${lines.length}.\nThe pauses between lines are probably too short to detect. `
                + `Re-record with a clear beat\nbetween each line, or drop --align and lay the take `
                + `down as recorded.`,
            );
            process.exit(1);
        }

        console.log(`aligning ${path.relative(root, single)} (${total.toFixed(1)}s take)\n`);
        // one copy of the input per line: a filter input pad cannot be consumed twice
        parts.push({label: null, filter: `[${idx}:a]asplit=${lines.length}${lines.map((_, i) => `[k${i}]`).join('')}`});

        lines.forEach((line, i) => {
            const span = spans[i];
            const len = span.end - span.start;
            const over = len - line.budget;
            console.log(
                `  ${line.id}  take ${span.start.toFixed(1).padStart(5)}s → video ${line.start.toFixed(1).padStart(5)}s`
                + `   ${len.toFixed(1)}s / ${line.budget}s  ${over > 0.15 ? `OVER by ${over.toFixed(1)}s` : 'ok'}`,
            );
            if (over > 0.15) {
                console.warn(`        ↳ "${line.text}" runs into the next beat — read it faster or trim the line`);
            }
            // A lead-in keeps a soft first consonant from being clipped off the front. Subtract it
            // back out of the delay, or every line would land that much late.
            const head = Math.min(PAD, span.start);
            const ms = Math.max(0, Math.round((line.start - head) * 1000));
            parts.push({
                label: `a${i}`,
                filter: `[k${i}]atrim=start=${span.start - head}:end=${span.end + PAD},`
                    + `asetpts=PTS-STARTPTS,adelay=${ms}:all=1[a${i}]`,
            });
        });
    } else {
        parts.push({label: 'a0', filter: `[${idx}:a]anull[a0]`});
        console.log(
            `voiceover  ${path.relative(root, single)} laid down from 0:00 as recorded.\n`
            + `           add --align to re-sync each line to the picture.`,
        );
    }
} else {
    let missing = 0;
    lines.forEach((line) => {
        const clip = findClip(line.id);
        if (!clip) {
            console.warn(`  missing   ${line.id}  "${line.text}"`);
            missing += 1;
            return;
        }

        const len = durationOf(clip);
        const over = len - line.budget;
        console.log(
            `  ${line.id}  @${line.start.toFixed(1).padStart(5)}s  ${len.toFixed(1)}s / ${line.budget}s`
            + `  ${over > 0.15 ? `OVER by ${over.toFixed(1)}s` : 'ok'}`,
        );
        if (over > 0.15) {
            console.warn(`        ↳ will bleed into the next beat — re-record shorter, or nudge `
                + `"start" for ${line.id} in vo/lines.json`);
        }

        const idx = inputs.length;
        inputs.push(clip);
        const ms = Math.round(line.start * 1000);
        // adelay needs one delay per channel; `all=1` applies it to every channel of the input
        parts.push({label: `a${idx}`, filter: `[${idx}:a]adelay=${ms}:all=1[a${idx}]`});
    });

    if (missing === lines.length) {
        console.error(`\nNo clips found in ${path.relative(root, VO_DIR)}/. Expected 01…12 `
            + `(wav/mp3/m4a), or pass --single for one continuous take. See script.md.`);
        process.exit(1);
    }
    if (missing > 0) console.warn(`\n${missing} line(s) missing — merging without them.\n`);
}

if (music) {
    if (!fs.existsSync(music)) {
        console.error(`--music file not found: ${music}`);
        process.exit(1);
    }
    const idx = inputs.length;
    inputs.push(music);
    // trimmed to length and faded out, so the bed cannot outlive the picture
    parts.push({
        label: `a${idx}`,
        filter: `[${idx}:a]atrim=0:${duration},volume=${musicGain},afade=t=out:st=${duration - 1.2}:d=1.2[a${idx}]`,
    });
    console.log(`music      ${path.relative(root, music)} at gain ${musicGain}`);
}

const mixed = parts.filter((p) => p.label);
// normalize=0 keeps every source at its own level; the default would duck each one by 1/N
const graph = [
    ...parts.map((p) => p.filter),
    `${mixed.map((p) => `[${p.label}]`).join('')}amix=inputs=${mixed.length}:duration=longest`
        + `:dropout_transition=0:normalize=0[mix]`,
].join(';');

const args = [
    ...inputs.flatMap((f) => ['-i', f]),
    '-filter_complex', graph,
    '-map', '0:v',
    '-map', '[mix]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', String(duration),
    '-y', DEST,
];

console.log(`\nmerging ${mixed.length} track(s) → ${path.relative(root, DEST)}`);
execFileSync('ffmpeg', ['-v', 'error', ...args], {stdio: 'inherit'});
console.log('done. the silent cut at out/wen-launch.mp4 is untouched.');
