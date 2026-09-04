/**
 * Generates the voiceover with OpenAI text-to-speech, one clip per line.
 *
 *   node scripts/tts.js                        # all twelve lines → vo/01…12.wav
 *   node scripts/tts.js --voice ash            # try a different voice
 *   node scripts/tts.js --sample               # one line in every voice → vo/sample/
 *   node scripts/tts.js --only 09,10           # regenerate just these
 *   node scripts/tts.js --no-fit               # don't retry over-budget lines faster
 *
 * Each line carries its own delivery note in vo/lines.json, and those go straight into the API's
 * `instructions` field — which is the reason to use this model rather than a plain TTS: the note
 * that says "flat challenge, no upward inflection" actually reaches the voice.
 *
 * Lines that come back longer than their budget are re-requested at a proportionally higher speed,
 * because a line that overruns will talk over the next visual beat. --no-fit turns that off.
 *
 * Needs OPENAI_API_KEY in the environment, or an OPENAI_API_KEY= line in video/.env or ../.env.
 * The key is never printed or written anywhere.
 */
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const root = path.join(__dirname, '..');
const VO_DIR = path.join(root, 'vo');

const MODEL = 'gpt-4o-mini-tts';
const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

/**
 * The house style, prepended to every line's own note.
 *
 * The video makes a claim that can be checked on-chain. An excited read makes a true claim sound
 * like a false one, so the direction is deliberately flat.
 */
const TONE = 'Dry, certain and understated. A documentary narrator, not a trailer voice-over. '
    + 'Measured pace, plain delivery, no upward inflection at the ends of sentences, no '
    + 'salesmanship or excitement. Leave small pauses at punctuation.';

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const voice = flag('--voice', 'onyx');
const sample = has('--sample');
const fit = !has('--no-fit');
const only = flag('--only');

if (!VOICES.includes(voice)) {
    console.error(`Unknown voice "${voice}". Available: ${VOICES.join(', ')}`);
    process.exit(1);
}

// ── key ──────────────────────────────────────────────────────────────
/** Reads OPENAI_API_KEY from the environment, or from a .env file, without ever logging it. */
const readKey = () => {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
    for (const f of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
        if (!fs.existsSync(f)) continue;
        const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.trim().startsWith('OPENAI_API_KEY='));
        if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
    return null;
};

const key = readKey();
if (!key) {
    console.error(
        'No OPENAI_API_KEY found.\n\n'
        + 'Set it in your shell profile:\n'
        + '  echo \'export OPENAI_API_KEY="sk-…"\' >> ~/.zshrc && source ~/.zshrc\n\n'
        + 'or drop a line into video/.env (already gitignored):\n'
        + '  OPENAI_API_KEY=sk-…\n',
    );
    process.exit(1);
}

const {lines} = JSON.parse(fs.readFileSync(path.join(VO_DIR, 'lines.json'), 'utf8'));

const durationOf = (file) =>
    Number(
        execFileSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file,
        ]).toString().trim(),
    );

/** One request. Returns the audio bytes. */
const speak = async ({text, instructions, voice: v, speed}) => {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: MODEL,
            voice: v,
            input: text,
            instructions,
            response_format: 'wav',
            ...(speed && speed !== 1 ? {speed} : {}),
        }),
    });
    if (!res.ok) {
        // the body carries the useful part of an API error; the key is not in it
        throw new Error(`${res.status} ${res.statusText} — ${(await res.text()).slice(0, 400)}`);
    }
    return Buffer.from(await res.arrayBuffer());
};

// ── sampler: one line, every voice, so the voice can be chosen by ear ─
const runSample = async () => {
    const dir = path.join(VO_DIR, 'sample');
    fs.mkdirSync(dir, {recursive: true});
    // line 02 is the hardest read in the script — if a voice can land "Prove it." flat, it can do
    // the rest. Paired with 09 for a longer sentence to judge pace.
    const probes = lines.filter((l) => ['02', '09'].includes(l.id));

    for (const v of VOICES) {
        for (const line of probes) {
            const buf = await speak({text: line.text, instructions: `${TONE} ${line.note}`, voice: v});
            fs.writeFileSync(path.join(dir, `${v}-${line.id}.wav`), buf);
        }
        console.log(`  ${v.padEnd(8)} → vo/sample/${v}-02.wav, ${v}-09.wav`);
    }
    console.log(`\nListen through, then generate with:  node scripts/tts.js --voice <name>`);
};

// ── the real run ─────────────────────────────────────────────────────
const runAll = async () => {
    const wanted = only ? new Set(only.split(',').map((s) => s.trim().padStart(2, '0'))) : null;
    const todo = lines.filter((l) => !wanted || wanted.has(l.id));

    console.log(`voice ${voice} · model ${MODEL}\n`);
    let overruns = 0;

    for (const line of todo) {
        const dest = path.join(VO_DIR, `${line.id}.wav`);
        let speed = 1;
        let len = 0;

        // up to three attempts: as written, then progressively quicker to fit the beat
        for (let attempt = 0; attempt < 3; attempt += 1) {
            fs.writeFileSync(dest, await speak({
                text: line.text,
                instructions: `${TONE} ${line.note}`,
                voice,
                speed,
            }));
            len = durationOf(dest);
            if (!fit || len <= line.budget) break;
            // aim slightly inside the budget so the next attempt is not borderline
            speed = Math.min(1.3, Math.round((speed * (len / (line.budget * 0.94))) * 100) / 100);
            if (attempt === 2 || speed >= 1.3) break;
        }

        const over = len - line.budget;
        const note = over > 0.05 ? `OVER by ${over.toFixed(1)}s` : 'ok';
        if (over > 0.05) overruns += 1;
        console.log(
            `  ${line.id}  ${len.toFixed(1)}s / ${line.budget}s`
            + `${speed !== 1 ? `  @${speed}×` : '      '}  ${note}   ${line.text.slice(0, 46)}`,
        );
    }

    console.log(`\nwrote ${todo.length} clip(s) to vo/`);
    if (overruns) {
        console.log(
            `${overruns} still over budget — shorten the text in vo/lines.json, or accept the `
            + `overlap.\nThe merge will warn about the same lines.`,
        );
    }
    console.log('next:  npm run merge');
};

(sample ? runSample() : runAll()).catch((err) => {
    console.error(`\nfailed: ${err.message}`);
    process.exit(1);
});
