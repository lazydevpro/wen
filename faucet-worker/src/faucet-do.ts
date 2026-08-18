/**
 * The faucet, as a single Durable Object.
 *
 * Why a Durable Object and not KV: the whole job here is "has this address already been paid?".
 * KV is eventually consistent — two requests hitting different colos can both read "no claim yet"
 * and both pay out. That is a drain, not a rounding error. A Durable Object routes every claim to
 * one instance, so the read and the write cannot straddle each other.
 *
 * Being single-threaded is still not enough on its own. Every `await` is a yield point, so two
 * claims can interleave inside the check-then-pay sequence. `blockConcurrencyWhile` closes that,
 * and it also serialises the nonce: ethers derives the nonce from `eth_getTransactionCount`, so
 * two concurrent sends would otherwise reuse one and the second would be dropped.
 *
 * The lock is held across the broadcast but NOT across confirmation — `sendTransaction` resolves
 * once the node accepts the transaction, which is fast. Waiting for a receipt would pin the lock
 * for a whole block and queue everyone behind it.
 */
import {DurableObject} from 'cloudflare:workers';
import {formatEther, getAddress, isAddress, JsonRpcProvider, parseEther, Wallet} from 'ethers';
import type {Env} from './index';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ClaimResult {
    status: number;
    body: Record<string, unknown>;
}

/**
 * Whole minutes first. Flooring hours and ceiling minutes independently renders "23h 60m"
 * for anything in the last minute of an hour.
 */
function humanise(ms: number): string {
    const totalMin = Math.ceil(ms / 60000);
    return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

export class FaucetDO extends DurableObject<Env> {
    private readonly sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        // Cheap enough to run on every wake; the constructor re-runs after eviction.
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS claims (addr TEXT PRIMARY KEY, last_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ip_hits (ip TEXT NOT NULL, ts INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        `);
    }

    private get drip(): bigint {
        return parseEther(this.env.FAUCET_DRIP ?? '20');
    }

    private get dailyCap(): bigint {
        return parseEther(this.env.FAUCET_DAILY_CAP ?? '500');
    }

    private wallet(): Wallet {
        const provider = new JsonRpcProvider(
            this.env.CC3_RPC_URL,
            {chainId: Number(this.env.CC3_CHAIN_ID ?? 102031), name: 'cc3-testnet'},
            // Skip the auto-detect round trip, and CC3 does not want JSON-RPC batches.
            {staticNetwork: true, batchMaxCount: 1},
        );
        return new Wallet(this.env.FAUCET_PRIVATE_KEY, provider);
    }

    private meta(key: string): string | null {
        const row = this.sql.exec<{v: string}>('SELECT v FROM meta WHERE k = ?', key).toArray()[0];
        return row?.v ?? null;
    }

    private setMeta(key: string, value: string) {
        this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?', key, value, value);
    }

    /** Rolling 24h window for the global cap. */
    private rollDay(now: number): {start: number; total: bigint} {
        let start = Number(this.meta('dayStart') ?? 0);
        let total = BigInt(this.meta('dayTotal') ?? '0');
        if (!start || now - start > DAY_MS) {
            start = now;
            total = 0n;
            this.setMeta('dayStart', String(start));
            this.setMeta('dayTotal', '0');
        }
        return {start, total};
    }

    private cooldownLeft(addr: string, now: number): number {
        const row = this.sql
            .exec<{last_ms: number}>('SELECT last_ms FROM claims WHERE addr = ?', addr.toLowerCase())
            .toArray()[0];
        if (!row) return 0;
        return Math.max(0, row.last_ms + DAY_MS - now);
    }

    async status(rawAddress: string): Promise<Record<string, unknown>> {
        const now = Date.now();
        const {total} = this.rollDay(now);
        const wallet = this.wallet();
        const balance = await wallet.provider!.getBalance(wallet.address);

        const body: Record<string, unknown> = {
            drip: formatEther(this.drip),
            cooldownHours: 24,
            faucetBalance: formatEther(balance),
            claimsRemaining: Number(balance / this.drip),
            dayRemaining: formatEther(this.dailyCap - total),
            requiresCode: (this.env.FAUCET_CODE ?? '').length > 0,
        };

        if (rawAddress && isAddress(rawAddress)) {
            const addr = getAddress(rawAddress);
            const left = this.cooldownLeft(addr, now);
            body.address = addr;
            body.canClaim = left === 0;
            body.cooldownSeconds = Math.ceil(left / 1000);
            body.walletBalance = formatEther(await wallet.provider!.getBalance(addr));
        }
        return body;
    }

    async claim(rawAddress: string, code: string, ip: string): Promise<ClaimResult> {
        // Everything from the first read to the broadcast runs without interleaving.
        return this.ctx.blockConcurrencyWhile(async () => {
            const expected = this.env.FAUCET_CODE ?? '';
            if (expected && code !== expected) {
                return {status: 403, body: {error: 'invite code required or incorrect'}};
            }
            if (!isAddress(rawAddress)) {
                return {status: 400, body: {error: 'not a valid address'}};
            }

            const addr = getAddress(rawAddress);
            // isAddress() returns true for 0x0; without this the faucet burns a drip.
            if (addr === ZERO_ADDRESS) {
                return {status: 400, body: {error: 'cannot send to the zero address'}};
            }

            const now = Date.now();
            const left = this.cooldownLeft(addr, now);
            if (left > 0) {
                return {
                    status: 429,
                    body: {error: `already claimed — try again in ${humanise(left)}`, cooldownSeconds: Math.ceil(left / 1000)},
                };
            }

            const hourAgo = now - HOUR_MS;
            this.sql.exec('DELETE FROM ip_hits WHERE ts < ?', hourAgo);
            const hits = this.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM ip_hits WHERE ip = ?', ip).toArray()[0]?.n ?? 0;
            if (hits >= Number(this.env.FAUCET_IP_HOURLY ?? 5)) {
                return {status: 429, body: {error: 'too many claims from this network, try later'}};
            }

            const {total} = this.rollDay(now);
            const drip = this.drip;
            if (total + drip > this.dailyCap) {
                return {status: 503, body: {error: 'faucet has hit its daily cap — try again tomorrow'}};
            }

            const wallet = this.wallet();
            const balance = await wallet.provider!.getBalance(wallet.address);
            if (balance < drip * 2n) {
                return {status: 503, body: {error: 'faucet is dry'}};
            }

            // Reserve first: a claim that is broadcast but slow to confirm must not be claimable
            // twice. Rolled back below if the broadcast itself fails.
            this.sql.exec(
                'INSERT INTO claims (addr, last_ms) VALUES (?, ?) ON CONFLICT(addr) DO UPDATE SET last_ms = ?',
                addr.toLowerCase(),
                now,
                now,
            );
            this.sql.exec('INSERT INTO ip_hits (ip, ts) VALUES (?, ?)', ip, now);
            this.setMeta('dayTotal', String(total + drip));

            try {
                const tx = await wallet.sendTransaction({to: addr, value: drip});
                return {
                    status: 200,
                    body: {
                        ok: true,
                        amount: formatEther(drip),
                        txHash: tx.hash,
                        explorer: `https://creditcoin-testnet.blockscout.com/tx/${tx.hash}`,
                    },
                };
            } catch (e: any) {
                this.sql.exec('DELETE FROM claims WHERE addr = ?', addr.toLowerCase());
                this.sql.exec('DELETE FROM ip_hits WHERE ip = ? AND ts = ?', ip, now);
                this.setMeta('dayTotal', String(total));
                console.error(`drip to ${addr} failed:`, e?.shortMessage ?? e?.message);
                return {status: 500, body: {error: e?.shortMessage ?? 'send failed'}};
            }
        });
    }
}
