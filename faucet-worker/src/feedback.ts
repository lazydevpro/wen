/**
 * Player feedback → Discord.
 *
 * Posted to a channel rather than stored in a table on purpose: feedback you have to remember to
 * go and read is feedback you will not read. This lands where someone is already looking.
 *
 * The free text is the least useful part. What makes a report actionable is the context attached
 * to it — which screen, which phase, how many rounds in, and whether the tutorial was finished —
 * because "it's broken" during BETTING is a different bug from "it's broken" during SETTLING.
 *
 * No database behind it. If Discord rejects the post the payload is logged in full (observability
 * is on for this Worker) and the player is told it failed, so nothing is silently swallowed.
 */
import type {Env} from './index';

const MAX = {message: 1800, field: 120};   // Discord embeds cap around 2k per field

const kind_ = (v: unknown): 'bug' | 'idea' | 'confused' | 'praise' | 'note' =>
    v === 'bug' || v === 'idea' || v === 'confused' || v === 'praise' ? v : 'note';

// Strips control characters only. Built with RegExp from a string because writing the range as
// a literal here once lost its escape and silently became "space or hyphen" — which would have
// replaced every hyphen a player typed with a space.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const clean = (v: unknown, cap: number) =>
    String(v ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, cap);

export async function handleFeedback(env: Env, body: any, ip: string) {
    const message = clean(body?.message, MAX.message);
    if (message.length < 3) {
        return {status: 400, body: {error: 'say a little more than that'}};
    }
    if (!env.DISCORD_WEBHOOK_URL) {
        return {status: 503, body: {error: 'feedback is not configured'}};
    }

    const KINDS = {bug: 0xff4d4d, idea: 0x4976ff, confused: 0xffc24d, praise: 0x2fd07a, note: 0x4976ff};
    const kind: keyof typeof KINDS = kind_(body?.kind);
    const addr = clean(body?.address, 42);
    const ctx = body?.context ?? {};

    const colour = KINDS[kind];
    const field = (name: string, value: string) => ({name, value: value || '—', inline: true});

    const payload = {
        username: 'wen',
        embeds: [{
            title: `${kind}`,
            description: message,
            color: colour,
            fields: [
                field('screen', clean(ctx.screen, MAX.field)),
                field('phase', clean(ctx.phase, MAX.field)),
                field('rounds', clean(ctx.rounds, 12)),
                field('tutorial', ctx.tutorialDone ? 'finished' : 'not finished'),
                field('wallet', addr ? `\`${addr.slice(0, 10)}…${addr.slice(-6)}\`` : 'not connected'),
                field('viewport', clean(ctx.viewport, 24)),
                // Already collected by the page's error handler and previously thrown away. Half of
                // "the UI is broken" reports are one browser and one stack trace.
                {name: 'last error', value: clean(ctx.lastError, 400) || '—', inline: false},
                {name: 'agent', value: clean(ctx.ua, 300) || '—', inline: false},
            ],
            timestamp: new Date().toISOString(),
            footer: {text: `ip ${ip}`},
        }],
    };

    try {
        const r = await fetch(env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`discord ${r.status}: ${(await r.text()).slice(0, 160)}`);
        return {status: 200, body: {ok: true}};
    } catch (e: any) {
        // Nothing is lost quietly — the whole payload goes to the Worker log.
        console.error('feedback delivery failed', String(e?.message ?? e), JSON.stringify(payload));
        return {status: 502, body: {error: 'could not deliver that — try again in a moment'}};
    }
}
