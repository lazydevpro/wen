/**
 * wen — faucet + static host.
 *
 *   pnpm serve            # http://localhost:5173
 *
 * Serves web/ and a small faucet API from one process, so there is a single URL to share.
 *
 * Why a server rather than a faucet contract: a brand-new address holds zero CTC and cannot pay
 * gas to call anything. Here the server pays the gas and sends the drip, so a new player needs
 * nothing at all to get started.
 *
 * The key held here is a hot key. Guards, in order of how much they matter:
 *   - a per-address 24h cooldown, persisted so a restart does not reset it
 *   - a global daily cap, so a bug or a spray cannot drain the wallet
 *   - a per-IP hourly cap, to slow trivial abuse
 *   - an optional invite code (FAUCET_CODE), which is what actually keeps randoms out
 */
import 'dotenv/config';
import {createServer} from 'node:http';
import {readFile, readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {Contract, formatEther, isAddress, JsonRpcProvider, parseEther, Wallet, getAddress} from 'ethers';

const PORT = Number(process.env.PORT ?? 5173);
const WEB_ROOT = new URL('../../web/', import.meta.url).pathname;
const STATE_FILE = new URL('../data/faucet.json', import.meta.url).pathname;

const DRIP = parseEther(process.env.FAUCET_DRIP ?? '20');
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Ceiling on what the faucet can hand out in any rolling day, whatever else goes wrong. */
const DAILY_CAP = parseEther(process.env.FAUCET_DAILY_CAP ?? '500');
const IP_HOURLY_LIMIT = Number(process.env.FAUCET_IP_HOURLY ?? 5);
/** If set, ?code= (or JSON {code}) must match. This is what keeps the link friends-only. */
const CODE = process.env.FAUCET_CODE ?? '';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

interface State {
    claims: Record<string, number>; // address -> last claim ms
    ipHits: Record<string, number[]>; // ip -> recent claim timestamps
    dayStart: number;
    dayTotal: string; // wei, as string
}

function loadState(): State {
    mkdirSync(new URL('../data/', import.meta.url).pathname, {recursive: true});
    if (existsSync(STATE_FILE)) {
        try {
            return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        } catch {
            /* fall through to a fresh state */
        }
    }
    return {claims: {}, ipHits: {}, dayStart: Date.now(), dayTotal: '0'};
}

const state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const provider = new JsonRpcProvider(process.env.CC3_RPC_URL!);
const wallet = new Wallet(process.env.FAUCET_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY!, provider);

function rollDay() {
    if (Date.now() - state.dayStart > 24 * 60 * 60 * 1000) {
        state.dayStart = Date.now();
        state.dayTotal = '0';
    }
}

function cooldownLeft(addr: string): number {
    const last = state.claims[addr.toLowerCase()];
    if (!last) return 0;
    return Math.max(0, last + COOLDOWN_MS - Date.now());
}

function ipAllowed(ip: string): boolean {
    const hour = Date.now() - 60 * 60 * 1000;
    const hits = (state.ipHits[ip] ?? []).filter((t) => t > hour);
    state.ipHits[ip] = hits;
    return hits.length < IP_HOURLY_LIMIT;
}

const json = (res: any, code: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(payload);
};

async function handleStatus(res: any, url: URL) {
    const raw = url.searchParams.get('address') ?? '';
    rollDay();
    const balance = await provider.getBalance(wallet.address);
    const body: any = {
        drip: formatEther(DRIP),
        cooldownHours: 24,
        faucetBalance: formatEther(balance),
        claimsRemaining: Number(balance / DRIP),
        dayRemaining: formatEther(DAILY_CAP - BigInt(state.dayTotal)),
        requiresCode: CODE.length > 0,
    };
    if (raw && isAddress(raw)) {
        const left = cooldownLeft(raw);
        body.address = getAddress(raw);
        body.canClaim = left === 0;
        body.cooldownSeconds = Math.ceil(left / 1000);
        body.walletBalance = formatEther(await provider.getBalance(raw));
    }
    json(res, 200, body);
}

async function handleClaim(req: any, res: any, url: URL) {
    let payload: any = {};
    if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c);
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
            return json(res, 400, {error: 'malformed JSON'});
        }
    }

    const address = String(payload.address ?? url.searchParams.get('address') ?? '').trim();
    const code = String(payload.code ?? url.searchParams.get('code') ?? '');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim();

    if (CODE && code !== CODE) return json(res, 403, {error: 'invite code required or incorrect'});
    if (!isAddress(address)) return json(res, 400, {error: 'not a valid address'});

    const addr = getAddress(address);
    // isAddress() happily accepts 0x0 — without this the faucet burns a drip into the void
    if (addr === '0x0000000000000000000000000000000000000000') {
        return json(res, 400, {error: 'cannot send to the zero address'});
    }
    const left = cooldownLeft(addr);
    if (left > 0) {
        // round to whole minutes FIRST, or 23h + 60m is reported instead of 24h
        const totalMin = Math.ceil(left / 60000);
        const hrs = Math.floor(totalMin / 60);
        const mins = totalMin % 60;
        return json(res, 429, {
            error: `already claimed — try again in ${hrs}h ${mins}m`,
            cooldownSeconds: Math.ceil(left / 1000),
        });
    }
    if (!ipAllowed(ip)) return json(res, 429, {error: 'too many claims from this network, try later'});

    rollDay();
    if (BigInt(state.dayTotal) + DRIP > DAILY_CAP) {
        return json(res, 503, {error: 'faucet has hit its daily cap — try again tomorrow'});
    }

    const balance = await provider.getBalance(wallet.address);
    if (balance < DRIP * 2n) return json(res, 503, {error: 'faucet is dry'});

    // Reserve BEFORE sending, so a slow confirmation cannot be raced into a double claim.
    state.claims[addr.toLowerCase()] = Date.now();
    state.ipHits[ip] = [...(state.ipHits[ip] ?? []), Date.now()];
    state.dayTotal = String(BigInt(state.dayTotal) + DRIP);
    saveState();

    try {
        const tx = await wallet.sendTransaction({to: addr, value: DRIP});
        const rcpt = await tx.wait();
        console.log(`  drip ${formatEther(DRIP)} CTC → ${addr}  (${tx.hash})`);
        return json(res, 200, {
            ok: true,
            amount: formatEther(DRIP),
            txHash: tx.hash,
            block: rcpt?.blockNumber,
            explorer: `https://creditcoin-testnet.blockscout.com/tx/${tx.hash}`,
        });
    } catch (e: any) {
        // hand the slot back so a failed send doesn't burn someone's daily claim
        delete state.claims[addr.toLowerCase()];
        state.dayTotal = String(BigInt(state.dayTotal) - DRIP);
        saveState();
        console.error(`  ✗ drip to ${addr} failed:`, e.shortMessage ?? e.message);
        return json(res, 500, {error: e.shortMessage ?? 'send failed'});
    }
}

/**
 * Gated reveal — mirrors faucet-worker/src/reveal.ts so local and deployed behave identically.
 *
 * The reveal holds the hidden future path, so it is released only once the round asking for it is
 * Settled on-chain and was actually dealt this window. Serving these as plain files put the answer
 * one fetch away from any player.
 */
const GAME_ABI = [
    'function rounds(uint256) view returns (address player, bytes32 windowId, uint8 state, uint64 startBlock, uint64 settledAt, uint128 ante, uint128 staked, uint128 paidOut)',
];
const STATE_SETTLED = 2;

async function handleReveal(res: any, url: URL, id: string) {
    const file = join(WEB_ROOT, 'data', `${id}.reveal.json`);
    if (!existsSync(file)) return json(res, 404, {error: 'unknown window'});

    const windows = JSON.parse(readFileSync(join(WEB_ROOT, 'data', 'windows.json'), 'utf8'));
    const win = windows.find((w: any) => w.id === id);
    if (!win) return json(res, 404, {error: 'unknown window'});

    const roundIdRaw = url.searchParams.get('roundId') ?? '';
    if (!/^\d+$/.test(roundIdRaw) || roundIdRaw === '0') return json(res, 400, {error: 'roundId required'});

    const game = new Contract(process.env.GRID_GAME_ADDRESS!, GAME_ABI, provider);
    let round: any;
    try {
        round = await game.rounds(BigInt(roundIdRaw));
    } catch {
        return json(res, 502, {error: 'could not read the round on-chain'});
    }

    if (Number(round.state) < STATE_SETTLED) return json(res, 403, {error: 'bets are not locked in yet'});
    if (String(round.windowId).toLowerCase() !== String(win.windowId).toLowerCase()) {
        return json(res, 403, {error: 'that round was not dealt this window'});
    }
    return json(res, 200, JSON.parse(readFileSync(file, 'utf8')));
}

function serveStatic(req: any, res: any, url: URL) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    // Match the deployed setup, where these are never uploaded as public assets.
    if (rel.endsWith('.reveal.json')) return json(res, 404, {error: 'not found'});
    // keep the path inside WEB_ROOT
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(WEB_ROOT, safe);
    if (!file.startsWith(WEB_ROOT)) return json(res, 403, {error: 'forbidden'});

    readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            return res.end('not found');
        }
        res.writeHead(200, {
            'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return json(res, 204, {});

    try {
        if (url.pathname === '/api/faucet/status') return await handleStatus(res, url);
        if (url.pathname === '/api/faucet') return await handleClaim(req, res, url);
        const reveal = url.pathname.match(/^\/api\/reveal\/([a-z0-9-]+)$/);
        if (reveal) return await handleReveal(res, url, reveal[1]);
        return serveStatic(req, res, url);
    } catch (e: any) {
        console.error('server error:', e);
        json(res, 500, {error: 'internal error'});
    }
});

server.listen(PORT, async () => {
    const bal = await provider.getBalance(wallet.address);
    console.log('='.repeat(64));
    console.log('HINDSIGHT — game + faucet');
    console.log('='.repeat(64));
    console.log(`  url        : http://localhost:${PORT}`);
    console.log(`  faucet from: ${wallet.address}`);
    console.log(`  balance    : ${formatEther(bal)} CTC  (~${bal / DRIP} drips)`);
    console.log(`  drip       : ${formatEther(DRIP)} CTC per address / 24h`);
    console.log(`  daily cap  : ${formatEther(DAILY_CAP)} CTC`);
    console.log(`  invite code: ${CODE ? 'REQUIRED — share ?code=…' : 'none (open to anyone with the link)'}`);
    console.log('='.repeat(64));
});
