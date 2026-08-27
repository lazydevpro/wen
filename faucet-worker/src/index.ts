/**
 * wen on Cloudflare — static client + faucet + gated reveals, one Worker.
 *
 *   npm run dev        # local, against real CC3
 *   npm run deploy     # https://wen.<subdomain>.workers.dev
 *
 * Static assets are served by the platform, not by this code: `run_worker_first` in
 * wrangler.jsonc limits the Worker to /api/*, so the chart and window data come off the
 * edge cache and never spend Worker CPU.
 */
import {FaucetDO} from './faucet-do';
import {handleFeedback} from './feedback';
import {handleResolve} from './resolve';
import {handleReveal} from './reveal';

export {FaucetDO};

export interface Env {
    ASSETS: Fetcher;
    FAUCET: DurableObjectNamespace<FaucetDO>;

    CC3_RPC_URL: string;
    CC3_CHAIN_ID: string;
    GRID_GAME_ADDRESS: string;
    FAUCET_DRIP: string;
    FAUCET_DAILY_CAP: string;
    FAUCET_IP_HOURLY: string;

    // secrets — `wrangler secret put`
    FAUCET_PRIVATE_KEY: string;
    /** Separate from the faucet key on purpose: two code paths sharing one wallet means two
     *  nonce sources, which is exactly how this project stalled runs before. */
    KEEPER_PRIVATE_KEY: string;
    /** Discord incoming webhook. Secret — anyone holding it can post to the channel. */
    DISCORD_WEBHOOK_URL: string;
    FAUCET_CODE: string;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });

/** Single global instance — every claim has to queue behind the same lock to be safe. */
const faucet = (env: Env) => env.FAUCET.get(env.FAUCET.idFromName('global'));

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') return json(204, {});

        if (url.pathname === '/api/faucet/status') {
            const body = await faucet(env).status(url.searchParams.get('address') ?? '');
            return json(200, body);
        }

        if (url.pathname === '/api/faucet') {
            let payload: any = {};
            if (request.method === 'POST') {
                try {
                    payload = await request.json();
                } catch {
                    return json(400, {error: 'malformed JSON'});
                }
            }
            const address = String(payload.address ?? url.searchParams.get('address') ?? '').trim();
            const code = String(payload.code ?? url.searchParams.get('code') ?? '');
            // Cloudflare sets this itself, so it cannot be spoofed by a client header.
            const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

            const {status, body} = await faucet(env).claim(address, code, ip);
            return json(status, body);
        }

        // keyed by windowId (0x + 64 hex) — the client never sees window ids like "luna-2022-s3"
        if (url.pathname === '/api/feedback' && request.method === 'POST') {
            let payload: any = {};
            try { payload = await request.json(); } catch {}
            const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
            const {status, body} = await handleFeedback(env, payload, ip);
            return json(status, body);
        }

        // Keeper: settles the payout so the player does not sign a third time. Best effort —
        // the client falls back to letting them resolve it themselves.
        if (url.pathname === '/api/resolve' && request.method === 'POST') {
            let payload: any = {};
            try { payload = await request.json(); } catch {}
            const {status, body} = await handleResolve(env, String(payload.roundId ?? ''));
            return json(status, body);
        }

        const revealMatch = url.pathname.match(/^\/api\/reveal\/(0x[0-9a-fA-F]{64})$/);
        if (revealMatch) {
            const {status, body} = await handleReveal(env, revealMatch[1], url.searchParams.get('roundId'));
            return json(status, body);
        }

        // Anything else that reaches the Worker falls through to the static client.
        return env.ASSETS.fetch(request);
    },
};
