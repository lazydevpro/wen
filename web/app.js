/**
 * wen — client.
 *
 * Round flow, and why it's shaped this way:
 *
 *   connect → pick an ante → startRound() lands on-chain → ONLY THEN is the window known and
 *   the chart drawn → 45s to bet → settleRound() → resolveRound()
 *
 * There is no deposit step. startRound and settleRound are payable: whatever the table credit
 * doesn't cover rides along as msg.value on a transaction the player signs anyway, so a fresh
 * faucet wallet plays in one popup. Winnings still accumulate as credit and are withdrawable.
 *
 * The ante has to be a real transaction that confirms *before* the chart appears. Otherwise a
 * player deals, reverse-searches the candle series against public price history, and walks away
 * for free. Two transactions per round is the price of that property being real rather than a
 * UI convention.
 *
 * The chart itself is drawn to <canvas> as pixels — no numeric price series ever reaches the DOM.
 */
import {BrowserProvider, Contract, formatEther, parseEther, keccak256, solidityPacked} from 'https://esm.sh/ethers@6.17.0';

const $ = (id) => document.getElementById(id);

/**
 * Canvas can't read CSS variables, so pull them off :root. Keeps styles.css the single source
 * of truth for colour — the chart drifting out of sync with the interface is how the old
 * palette ended up with a pink line nothing else used.
 */
const paletteCache = new Map();
function palette(name) {
    if (!paletteCache.has(name)) {
        paletteCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    }
    return paletteCache.get(name);
}


const CC3_CHAIN_ID = 102031;
const CC3_CHAIN_ID_HEX = '0x18e8f';

/**
 * Exactly the shape `wallet_addEthereumChain` expects — the key must be `chainId`, and the
 * explorer URL must actually resolve or several wallets reject the whole call.
 */
const CC3_PARAMS = {
    chainId: CC3_CHAIN_ID_HEX,
    chainName: 'Creditcoin CC3 Testnet',
    nativeCurrency: {name: 'Creditcoin', symbol: 'CTC', decimals: 18},
    rpcUrls: ['https://rpc.cc3-testnet.creditcoin.network'],
    blockExplorerUrls: ['https://creditcoin-testnet.blockscout.com'],
};

const GRID_GAME = '0x5D2b31f37342d6a842742628e49b70f0f3507b96';

/**
 * Superseded deployments. Winnings live as in-contract credit, so every migration leaves any
 * un-withdrawn player credit behind on the old address — invisible to a client that only knows
 * the current game. On connect each of these is checked and anything found is offered back.
 * withdraw() has no pause gate and player credit is not the bankroll, so recovery always works.
 */
const LEGACY_GAMES = [
    '0x5659942E63a62017c11E8668abbD8FbfEb335939',
    '0x0e60CdA4959849244095D1f0ED0F787e8Da39Ac3',
    '0xf16a2151144d5394D89445F0BcC20A2e6db8Fc2d',
    '0x9FBfeB2Fcd11EAd928f036E48807112f9670Fd7A',
    '0x1BF8d7f54Dda5699dA359B4AECfa6bA7582909cC',
    '0x783432Bf4Eb7A15eE95D003b7a13404F6C70456c',
];
const LEGACY_ABI = ['function balances(address) view returns (uint256)', 'function withdraw(uint256)'];
const REGISTRY = '0xBCf9D65e6eb421B6dbf2CaEDbB21bCcBD0337dC5';
const VERIFIER = '0xE64f8b159FC22F9B0B1ca4980362eB5765cAb0f3';
const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const EXPLORER = 'https://creditcoin-testnet.blockscout.com';
const VERIFIER_ABI = ['function candleCount(address) external view returns (uint256)'];
const REGISTRY_ABI = [
    'function windowCount() external view returns (uint256)',
    'function windowIds(uint256) external view returns (bytes32)',
];

const GAME_ABI = [
    'function deposit() external payable',
    'function withdraw(uint256 amount) external',
    'function balances(address) external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    // read by the lobby strip
    'function bankroll() external view returns (uint256)',
    'function nextRoundId() external view returns (uint256)',
    'function maxRoundExposure() external view returns (uint256)',
    'function DECISION_BLOCKS() external view returns (uint256)',
    'function startRound(uint128 ante) external payable returns (uint256)',
    'function settleRound(uint256 roundId,uint8[] ts,uint8[] ps,uint128[] amounts) external payable',
    'function settleDirection(uint256 roundId,bool up,uint128 stake) external payable',
    'function DIRECTION_UP_MULT() external view returns (uint32)',
    'function DIRECTION_DOWN_MULT() external view returns (uint32)',
    'event DirectionSettled(uint256 indexed roundId,address indexed player,bool up,uint256 staked,uint256 maxPayout)',
    'function resolveRound(uint256 roundId,uint256[] indices,uint64[] blockNumbers,uint160[] sqrtPrices,bytes32[][] proofs) external',
    'function roundSummary(uint256) external view returns (address,bytes32,uint8,uint128,uint128,uint128)',
    'function deadlineOf(uint256) external view returns (uint256)',
    'event RoundDealt(uint256 indexed roundId,address indexed player,uint128 ante,uint64 deadlineBlock,uint64 revealBlock)',
    'function windowOf(uint256 roundId) external view returns (bytes32)',
    'error WindowNotYetKnown(uint256 revealBlock,uint256 currentBlock)',
    'error WindowExpired(uint256 revealBlock)',
    'error TooSoonToResolve(uint64 settledBlock,uint256 currentBlock)',
    'error TotalExposureTooHigh(uint256 requested,uint256 cap)',
    'event RoundSettled(uint256 indexed roundId,address indexed player,uint256 staked,uint256 maxPayout)',
    'event RoundResolved(uint256 indexed roundId,address indexed player,uint256 payout)',
    // Without these, every revert surfaces as "unknown custom error" and the player is told
    // nothing about why their bet failed.
    'error GamePaused()',
    'error NoWindows()',
    'error NoBets()',
    'error InsufficientBalance(uint256 needed,uint256 have)',
    'error AnteTooSmall()',
    'error BetTooLarge(uint256 amount,uint256 maxBet)',
    'error StakeBelowAnte(uint256 staked,uint128 ante)',
    'error ExposureTooHigh(uint256 maxPayout,uint256 cap)',
    'error CellOutOfRange(uint8 t,uint8 p)',
    'error DuplicateCell(uint8 t,uint8 p)',
    'error WrongRoundState(uint256 roundId)',
    'error NotPlayer()',
    'error DecisionWindowClosed(uint64 deadlineBlock,uint256 current)',
    'error DecisionWindowStillOpen(uint64 deadlineBlock,uint256 current)',
    'error RevealCountMismatch(uint256 expected,uint256 got)',
    'error BadCandleProof(uint256 index)',
    'error InsufficientBankroll(uint256 needed,uint256 have)',
    // ChartRegistry errors surface through game calls; without these they print as "unknown"
    'error UnknownWindow(bytes32 windowId)',
    'error BadMerkleProof(uint256 candleIndex)',
];

/** Turn a revert into something a player can act on. */
function explain(e) {
    const name = e?.revert?.name ?? e?.info?.error?.data?.name;
    const args = e?.revert?.args ?? [];
    switch (name) {
        case 'DecisionWindowClosed':
            return 'too slow — the round closed and your opening stake is forfeit';
        case 'ExposureTooHigh':
            return 'max win is too high for the bankroll — spread your bets across more cells';
        case 'StakeBelowAnte':
            return `you must stake at least your ante (${state.ante} CTC)`;
        case 'BetTooLarge':
            return `one bet is over the per-cell limit of ${state.maxBet.toFixed(1)} CTC`;
        case 'InsufficientBalance':
            return 'not enough CTC — grab some from the faucet';
        case 'WrongRoundState':
            return 'this round was already settled or expired';
        case 'GamePaused':
            return 'the game is paused (drawdown breaker tripped)';
        case 'DuplicateCell':
            return 'the same cell was bet twice';
        case 'CellOutOfRange':
            return 'a bet landed outside the grid';
        case 'NotPlayer':
            return 'this round belongs to another address';
        default:
            break;
    }
    if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return 'you rejected the transaction';
    return (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 140);
}

const DECISION_SECONDS = 45;
/**
 * Mirrors GridGame.DIRECTION_*_MULT. Asymmetric on purpose: the window pool closes up 54.2% of
 * the time, so paying both sides alike would let an always-up bot play at break-even.
 */
const DIR_MULT = {up: 1.7, down: 1.9};

const ANTES = [0.5, 1, 2, 5];
const STAKES = [0.5, 1, 2, 5];

/**
 * Both panes show the stake, so writing one readout by hand desynced them the moment simple mode
 * arrived. Everything that changes the stake goes through here: it updates both, and re-syncs —
 * the stake decides which grid cells are unaffordable and what the direction bet is worth, so
 * skipping that left stale limits on screen either way.
 */
function setStakeIdx(idx) {
    state.stakeIdx = Math.max(0, Math.min(STAKES.length - 1, idx));
    state.stake = STAKES[state.stakeIdx];
    renderStake();
    syncBets();
}

function renderStake() {
    for (const id of ['stakeValue', 'stakeValueSimple']) {
        const el = $(id);
        if (el) el.textContent = state.stake;
    }
}

/**
 * Where the round is, as one value.
 *
 * This used to be four unrelated flags — settling, reveal, timer, win — re-derived at every call
 * site that needed a guard, and they disagreed: `if (state.reveal || state.settling)` in one place
 * and `if (state.settling)` in another were both asking "are we still betting?".
 *
 * It has to be explicit because of the clock. On expiry the round either locks in whatever is
 * selected or forfeits the ante, so anything that can steal input mid-round can cost real value —
 * and a modal dialog makes the whole page `inert`. "May a dialog open right now?" needs exactly
 * one answer, and this is it.
 */
const PHASE = {
    IDLE: 'idle',           // no round; the only phase from which one can be dealt
    DEALING: 'starting',     // ante submitted, window not yet known
    BETTING: 'betting',     // chart up, clock running — the dangerous one
    SETTLING: 'settling',   // bets submitted, awaiting confirmation
    REVEALING: 'revealing', // animating the hidden path
    RESULT: 'result',       // round over, chart still on screen
};

/** Dialogs may only interrupt when nothing is at stake. */
const DIALOG_PHASES = new Set([PHASE.IDLE, PHASE.RESULT]);
const canOpenDialog = () => DIALOG_PHASES.has(state.phase);
const isRoundLive = () => !DIALOG_PHASES.has(state.phase);

const state = {
    provider: null,
    signer: null,
    game: null,
    address: null,
    credit: 0n,
    wallet: 0n,
    win: null,
    roundId: null,
    ante: 1,
    stake: 1,
    stakeIdx: 1,
    anteIdx: 1,
    picks: new Map(),
    mode: 'grid',        // 'grid' | 'simple' — chosen after the deal, never before
    dir: null,           // true = up, false = down
    maxBet: 0,
    maxExposure: 0,
    phase: PHASE.IDLE,
    reveal: null,
    guessed: false,
    timer: null,
    deadline: 0,
};

// ─────────────────────────────────────────────────────────── boot

(async function init() {
    setPhase(PHASE.IDLE);   // publish the starting phase rather than only transitions
    renderAnteGrid();
    wireControls();
    startLanding();
    if (window.ethereum?.selectedAddress) connect().catch(() => {});
})();

// ─────────────────────────────────────────────────────── landing

/**
 * The word is the pitch. The typewriter walks the "wen …" memes everyone already knows, then
 * lands on the question this game actually answers — that one gesture explains the name, the
 * brand and the mechanic without a paragraph of copy. Behind it, an ambient synthetic random
 * walk draws itself; synthetic on purpose, so the landing can never leak a real window.
 * Both idle out whenever the connect screen is not the active one.
 */
function startLanding() {
    const cycleEl = $('wenCycle');
    const cv = $('heroChart');
    if (!cycleEl || !cv) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onLanding = () => $('screenConnect').classList.contains('active');

    const FINAL = 'is this chart from?';
    if (reduced) {
        cycleEl.textContent = FINAL;
    } else {
        const lines = ['moon?', 'lambo?', 'listing?', FINAL];
        let i = 0;
        (async function loop() {
            for (;;) {
                const text = lines[i % lines.length];
                for (let n = 1; n <= text.length; n++) {
                    if (onLanding()) cycleEl.textContent = text.slice(0, n);
                    await new Promise((r) => setTimeout(r, 52));
                }
                await new Promise((r) => setTimeout(r, text === FINAL ? 3600 : 950));
                for (let n = text.length; n >= 0; n--) {
                    if (onLanding()) cycleEl.textContent = text.slice(0, n);
                    await new Promise((r) => setTimeout(r, 24));
                }
                i++;
            }
        })();
    }

    // ambient chart: a slow random walk, redrawn from scratch each pass
    const ctx = cv.getContext('2d');
    let pts = [];
    let t = 0;
    const step = () => {
        if (!onLanding()) return requestAnimationFrame(step);
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (t % 3 === 0) {
            const last = pts.length ? pts[pts.length - 1] : h * 0.55;
            pts.push(Math.min(h * 0.9, Math.max(h * 0.1, last + (Math.random() - 0.495) * h * 0.045)));
            if (pts.length > 260) pts = [];   // start a fresh pass
        }
        t++;

        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = palette('--hairline');
        ctx.lineWidth = 1;
        for (let gy = 1; gy < 5; gy++) {
            ctx.beginPath(); ctx.moveTo(0, (h * gy) / 5); ctx.lineTo(w, (h * gy) / 5); ctx.stroke();
        }
        if (pts.length > 1) {
            ctx.beginPath();
            pts.forEach((y, idx) => { const x = (idx / 259) * w; idx ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.strokeStyle = palette('--ink-faint');
            ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
            ctx.beginPath();
            ctx.arc(((pts.length - 1) / 259) * w, pts[pts.length - 1], 3, 0, Math.PI * 2);
            ctx.fillStyle = palette('--blue');
            ctx.fill();
        }
        if (!reduced) requestAnimationFrame(step);
    };
    if (reduced) {
        // one complete static line instead of an animation
        let last = cv.clientHeight * 0.55 || 200;
        for (let n = 0; n < 260; n++) {
            last = Math.min(cv.clientHeight * 0.9, Math.max(cv.clientHeight * 0.1, last + (Math.random() - 0.495) * cv.clientHeight * 0.045));
            pts.push(last);
        }
    }
    step();
}

function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * The only way the phase changes. Every affordance that must not be reachable mid-round is
 * disabled from here, so adding a control later cannot forget the rule.
 */
function setPhase(next) {
    state.phase = next;
    const live = isRoundLive();
    for (const id of ['btnFaucet', 'btnWithdraw', 'btnDeal', 'btnConnect']) {
        const el = $(id);
        if (el) {
            el.toggleAttribute('data-round-live', live);
            el.disabled = live;
        }
    }
    // the topbar withdraw is visible everywhere, so it must also hide mid-round
    updateWithdraw();
    document.body.dataset.phase = next;
}

function show(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(screen).classList.add('active');
}

// ─────────────────────────────────────────────── transaction dialog

/**
 * Transaction progress as a modal, not a flat overlay. showModal() dims and inerts the page,
 * which is exactly right here: during a signature or a pending transaction there is nothing
 * else the player can meaningfully do. Never user-dismissable — closing it wouldn't stop the
 * transaction, only hide it. Safe with the phase rule because it only ever opens in DEALING
 * and SETTLING, when the clock is not running.
 */
function txOpen(msg) {
    const d = $('txDialog');
    d.classList.remove('error');
    $('txStatus').textContent = msg;
    $('txActions').hidden = true;
    if (!d.open) d.showModal();
}

function txSet(msg) {
    $('txStatus').textContent = msg;
}

function txClose() {
    const d = $('txDialog');
    if (d.open) d.close();
}

/** Terminal state: message plus the one useful action. */
function txError(msg, onBail) {
    const d = $('txDialog');
    d.classList.add('error');
    $('txStatus').innerHTML = `<strong>${msg}</strong>`;
    $('txActions').hidden = false;
    $('btnTxBail').onclick = () => { txClose(); onBail(); };
    if (!d.open) d.showModal();
}

// ─────────────────────────────────────────────── skeleton + riddle intro

/**
 * While the deal confirms, the table loads in its own shape — shimmer cells where the grid
 * will be, shimmer bars where the chart will be — instead of a spinner over a blank.
 */
function skeletonTable() {
    $('riddleText').textContent = '';
    $('riddleText').classList.add('skel', 'skel-fill');
    $('clock').textContent = '—';
    $('anchorPrice').textContent = '$ —';
    document.querySelector('.canvas-wrap').classList.add('skel');
    const cv = $('chart');
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);

    const ov = $('gridOverlay');
    ov.style.gridTemplateColumns = 'repeat(8, 1fr)';
    ov.style.gridTemplateRows = 'repeat(12, 1fr)';
    ov.innerHTML = Array.from({length: 96}, () => '<div class="cell skel"><i class="skel-fill"></i></div>').join('');
}

function clearSkeleton() {
    $('riddleText').classList.remove('skel', 'skel-fill');
    document.querySelector('.canvas-wrap').classList.remove('skel');
}

/**
 * The riddle's entrance: typed out centre-stage, held a beat, then a FLIP glide into the
 * panel slot it actually lives in. The clock is armed only after this finishes, so the
 * ceremony never eats decision time. Reduced motion skips straight to the table.
 */
async function riddleIntroPlay(text) {
    // Skip the ceremony when nobody is watching. A hidden tab clamps timers to one tick per
    // second, which would stretch this to minutes — all while the ON-CHAIN decision window
    // keeps counting. The ceremony must never spend the player's real budget.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) return;
    const wrap = $('riddleIntro');
    const el = $('riddleIntroText');
    el.style.transform = '';
    wrap.classList.remove('moving');
    el.textContent = '';
    wrap.hidden = false;

    // wall-clock bounded for the same reason: if timers are throttled mid-intro, finish the
    // text immediately rather than crawling
    const started = performance.now();
    for (let n = 1; n <= text.length; n++) {
        el.textContent = text.slice(0, n);
        if (performance.now() - started > 1400 || document.hidden) { el.textContent = text; break; }
        await new Promise((r) => setTimeout(r, 24));
    }
    if (!document.hidden) await new Promise((r) => setTimeout(r, 300));

    // FLIP: from centre-stage to wherever the real blockquote sits right now
    const from = el.getBoundingClientRect();
    const to = $('riddleText').getBoundingClientRect();
    const scale = to.width / from.width;
    wrap.classList.add('moving');
    el.style.transform =
        `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})`;
    await new Promise((r) => setTimeout(r, 420));
    wrap.hidden = true;
    wrap.classList.remove('moving');
    el.style.transform = '';
}

/** Total ceremony budget, wall-clock. Past this the table simply appears — never blocks the round. */
const INTRO_MAX_MS = 2600;
async function riddleIntro(text) {
    await Promise.race([riddleIntroPlay(text), new Promise((r) => setTimeout(r, INTRO_MAX_MS))]);
    // idempotent finalisation, whichever path won
    $('riddleIntro').hidden = true;
    $('riddleIntro').classList.remove('moving');
    $('riddleIntroText').style.transform = '';
}

// ─────────────────────────────────────────────────────── wallet

/** Wallets disagree about how they report "I don't know that chain". Catch all the variants. */
function isUnknownChainError(e) {
    const code = e?.code ?? e?.data?.originalError?.code ?? e?.error?.code;
    if (code === 4902 || code === -32603) return true;
    return /unrecognized chain|unknown chain|chain .* not (added|found)|add.*chain/i.test(e?.message ?? '');
}

/**
 * Make sure the wallet is on CC3, adding the network first if it doesn't know it.
 *
 * Adding does not reliably switch — some wallets add silently and stay put — so the result is
 * verified rather than assumed, with one retry.
 */
async function ensureCC3() {
    const eth = window.ethereum;
    if ((await eth.request({method: 'eth_chainId'})) === CC3_CHAIN_ID_HEX) return;

    try {
        toast('switching to Creditcoin CC3 Testnet…');
        await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: CC3_CHAIN_ID_HEX}]});
    } catch (e) {
        if (e?.code === 4001) throw new Error('network switch rejected');
        if (!isUnknownChainError(e)) throw e;

        toast('adding Creditcoin CC3 Testnet to your wallet…');
        try {
            await eth.request({method: 'wallet_addEthereumChain', params: [CC3_PARAMS]});
        } catch (addErr) {
            if (addErr?.code === 4001) throw new Error('network add rejected');
            throw addErr;
        }
    }

    // adding is not the same as switching — confirm, and nudge once if needed
    if ((await eth.request({method: 'eth_chainId'})) !== CC3_CHAIN_ID_HEX) {
        try {
            await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: CC3_CHAIN_ID_HEX}]});
        } catch { /* fall through to the check below */ }
    }

    const finalChain = await eth.request({method: 'eth_chainId'});
    if (finalChain !== CC3_CHAIN_ID_HEX) {
        throw new Error(`wrong network — expected CC3 (${CC3_CHAIN_ID}), wallet is on ${parseInt(finalChain, 16)}`);
    }
}

async function connect() {
    if (!window.ethereum) {
        toast('no wallet found — install MetaMask to play');
        return;
    }

    try {
        await window.ethereum.request({method: 'eth_requestAccounts'});
        await ensureCC3();
    } catch (e) {
        toast(explain(e));
        return;
    }

    // rebuild the provider after any network change so it reads the right chain
    state.provider = new BrowserProvider(window.ethereum);
    state.signer = await state.provider.getSigner();
    state.address = await state.signer.getAddress();
    state.game = new Contract(GRID_GAME, GAME_ABI, state.signer);

    $('btnConnect').hidden = true;
    $('addr').hidden = false;
    $('addr').textContent = state.address.slice(0, 6) + '…' + state.address.slice(-4);
    $('creditStat').hidden = false;

    await refreshCredit();
    refreshFaucet();
    show('screenLobby');
    loadHudStats();
    tour.start();
    checkLegacyCredit().catch(() => {});
}

/** Anything left behind on a superseded game is surfaced as a one-click recovery. */
async function checkLegacyCredit() {
    const found = [];
    for (const addr of LEGACY_GAMES) {
        const g = new Contract(addr, LEGACY_ABI, state.signer);
        const bal = await g.balances(state.address);
        if (bal > 0n) found.push({g, bal});
    }
    const total = found.reduce((a, f) => a + f.bal, 0n);
    const panel = $('legacyPanel');
    if (!panel) return;
    panel.hidden = total === 0n;
    if (total === 0n) return;

    $('legacyAmount').textContent = Number(formatEther(total)).toFixed(2);
    $('btnLegacy').onclick = async () => {
        const btn = $('btnLegacy');
        btn.disabled = true;
        try {
            let done = 0;
            for (const f of found) {
                btn.textContent = `confirm in wallet… (${done + 1}/${found.length})`;
                const tx = await f.g.withdraw(f.bal);
                btn.textContent = `recovering ${Number(formatEther(f.bal)).toFixed(2)} CTC…`;
                await tx.wait();
                done++;
            }
            toast('recovered to your wallet');
            panel.hidden = true;
            await refreshCredit();
        } catch (e) {
            toast(explain(e));
            btn.textContent = 'recover to wallet';
            btn.disabled = false;
        }
    };
}

/** Keep a little native CTC aside so attaching value can never leave the player unable to pay gas. */
const GAS_RESERVE = parseEther('0.05');

async function refreshCredit() {
    state.credit = await state.game.balances(state.address);
    state.wallet = await state.provider.getBalance(state.address);
    // both limits shrink with the bankroll, so read them rather than assuming
    state.maxBet = Number(formatEther(await state.game.maxBet()));
    state.maxExposure = Number(formatEther(await state.game.maxRoundExposure()));
    $('credit').textContent = Number(formatEther(state.credit)).toFixed(2);

    // credit plus wallet is what the player can actually stake — the deposit step is gone
    const spendable = state.credit + (state.wallet > GAS_RESERVE ? state.wallet - GAS_RESERVE : 0n);
    $('btnDeal').disabled = isRoundLive() || spendable < parseEther(String(state.ante));
    updateWithdraw();
}

/**
 * Winnings are pulled, never pushed — resolveRound is permissionless and must not be blockable
 * by a hostile receiver, so payouts land as credit and this is the one claim affordance.
 * It exists only when there is something to claim, and never during a live round.
 */
function updateWithdraw() {
    const btn = $('btnWithdraw');
    if (!btn) return;
    // mid-transaction the button narrates the transaction; don't repaint it from elsewhere
    if (btn.dataset.busy) return;
    const show = state.address && state.credit > 0n && !isRoundLive();
    btn.hidden = !show;
    if (show) btn.textContent = `withdraw ${Number(formatEther(state.credit)).toFixed(2)} CTC`;
}

/** How much value must ride along so `needed` clears the current credit. */
function shortfall(needed) {
    return needed > state.credit ? needed - state.credit : 0n;
}

// ─────────────────────────────────────────────────────── lobby

function renderAnteGrid() {
    const g = $('anteGrid');
    g.innerHTML = '';
    ANTES.forEach((a, i) => {
        const b = document.createElement('button');
        b.className = 'ante-chip' + (i === state.anteIdx ? ' on' : '');
        b.innerHTML = `<b>${a}</b><em>CTC</em>`;
        b.onclick = () => {
            state.anteIdx = i;
            state.ante = a;
            state.stake = a;
            state.stakeIdx = STAKES.indexOf(a) >= 0 ? STAKES.indexOf(a) : 1;
            renderStake();
            renderAnteGrid();
            refreshCredit();
            tour.notify('ante:picked');
        };
        g.appendChild(b);
    });
    $('decisionHint').textContent = `${DECISION_SECONDS}s`;
}

// ─────────────────────────────────────────────────────── window + reveal

/**
 * Fetch the one window this round was dealt.
 *
 * There is deliberately no catalogue to load. Shipping an index of every window would be a
 * ~1 MB download and would tell the player exactly how many charts exist and what they are —
 * the thing the blind deal is meant to prevent. The windowId only becomes knowable from the
 * RoundDealt receipt, so this cannot be fetched ahead of committing the ante.
 */
/**
 * windowOf() reverts until the block after the deal has been mined AND one more has passed, since
 * a block's own hash is not readable from inside it. About 15s on CC3. Polled rather than slept:
 * block times drift, and a fixed wait would either stall the deal or miss.
 */
/**
 * Which chart did this round draw?
 *
 * The contract derives it from the hash of the block the deal landed in, and that hash is sitting
 * right there in the receipt — so there is nothing to wait for. Asking the contract instead would
 * cost a whole extra block, because blockhash(N) is not readable from inside block N.
 *
 * Identical arithmetic to GridGame.windowOf(); the chain re-derives and enforces it at settle.
 * Falls back to polling the contract if anything here disagrees, so a formula drift degrades to
 * slow rather than broken.
 */
async function deriveWindow(roundId, dealBlockHash) {
    try {
        const reg = new Contract(REGISTRY, REGISTRY_ABI, state.provider);
        const n = await reg.windowCount();
        const seed = BigInt(
            keccak256(solidityPacked(['bytes32', 'address', 'uint256'], [dealBlockHash, state.address, roundId])),
        );
        return await reg.windowIds(seed % n);
    } catch (e) {
        return await awaitWindow(roundId);
    }
}

/**
 * The numbers along the top of the lobby, read live from chain.
 *
 * These are not decoration. "4,706 candles proven" is the entire claim of this project, and it is
 * one view call away from being checked — so it is shown as a fact the player can verify rather
 * than a sentence they have to believe. Failures are silent: a dead RPC should dim the strip, not
 * block someone from playing.
 */
async function loadHudStats() {
    const link = $('proofLink');
    if (link) link.href = `${EXPLORER}/address/${VERIFIER}`;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    try {
        const reg = new Contract(REGISTRY, REGISTRY_ABI, state.provider);
        const ver = new Contract(VERIFIER, VERIFIER_ABI, state.provider);
        const [candles, windows, bankroll, rounds] = await Promise.all([
            ver.candleCount(POOL),
            reg.windowCount(),
            state.game.bankroll(),
            state.game.nextRoundId(),
        ]);
        set('statCandles', Number(candles).toLocaleString());
        set('statWindows', Number(windows).toLocaleString());
        set('statBankroll', Math.round(Number(formatEther(bankroll))).toLocaleString());
        set('statRounds', Math.max(0, Number(rounds) - 1).toLocaleString());
    } catch (e) {
        ['statCandles', 'statWindows', 'statBankroll', 'statRounds'].forEach((id) => set(id, '—'));
    }
}

/** Block until the chain has moved past `after`. */
async function nextBlock(after) {
    if (!after) return;
    for (;;) {
        if ((await state.provider.getBlockNumber()) > after) return;
        await new Promise((r) => setTimeout(r, 400));
    }
}

async function awaitWindow(roundId, timeoutMs = 90000) {
    const started = Date.now();
    for (;;) {
        try {
            return await state.game.windowOf(roundId);
        } catch (e) {
            if (Date.now() - started > timeoutMs) throw new Error('the draw did not settle in time');
            await new Promise((r) => setTimeout(r, 400));
        }
    }
}

async function fetchWindow(windowId) {
    const r = await fetch(`data/w/${windowId}.json`);
    if (!r.ok) throw new Error('got a chart this client does not have');
    return r.json();
}

/**
 * The answer never ships as a static file — it would be one fetch away, and knowing the
 * hidden path before betting is the whole game. The server hands it over only once this
 * round is Settled on-chain, which is to say only once the bets can no longer change.
 */
async function fetchReveal(windowId, roundId) {
    const r = await fetch(`/api/reveal/${windowId}?roundId=${roundId}`);
    if (!r.ok) {
        const {error} = await r.json().catch(() => ({}));
        throw new Error(error ?? 'could not load the reveal');
    }
    return r.json();
}

// ─────────────────────────────────────────────────────── faucet

/** Invite code travels in the URL so the link can just be shared: ...?code=abc */
const INVITE_CODE = new URLSearchParams(location.search).get('code') ?? '';

async function refreshFaucet() {
    try {
        const q = state.address ? `?address=${state.address}` : '';
        const s = await (await fetch(`/api/faucet/status${q}`)).json();
        $('faucetLeft').textContent = `${Math.floor(Number(s.claimsRemaining))} drips left`;
        $('faucetPanel').classList.toggle('dry', Number(s.claimsRemaining) < 1);

        const btn = $('btnFaucet');
        if (s.canClaim === false) {
            // whole minutes first, else a countdown reads "23h 60m"
            const totalMin = Math.ceil(s.cooldownSeconds / 60);
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            btn.disabled = true;
            btn.textContent = `already claimed — ${h}h ${m}m to go`;
        } else {
            btn.disabled = false;
            btn.textContent = `send me ${Number(s.drip)} CTC`;
        }
    } catch {
        // faucet API not running (e.g. served as plain static files) — hide the card
        $('faucetPanel').hidden = true;
    }
}

async function claimFaucet() {
    if (!state.address) return toast('connect your wallet first');
    const btn = $('btnFaucet');
    const out = $('faucetResult');
    btn.disabled = true;
    btn.textContent = 'sending…';
    out.textContent = '';

    try {
        const r = await fetch('/api/faucet', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({address: state.address, code: INVITE_CODE}),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'faucet failed');

        out.className = 'guess-result faucet-result-ok';
        out.innerHTML = `✓ sent ${d.amount} CTC — <a href="${d.explorer}" target="_blank" rel="noreferrer">view tx</a>`;
        toast(`${d.amount} CTC on its way`);
        await refreshCredit();
        // The tour waits for the balance to move, not for the API to answer — the player should
        // see the CTC arrive, because that is the step's reward.
        tour.notify('faucet:landed');
    } catch (e) {
        out.className = 'guess-result faucet-result-no';
        out.textContent = '✗ ' + (e.message ?? e);
    } finally {
        refreshFaucet();
    }
}

async function doWithdraw() {
    if (state.credit === 0n) return;
    const btn = $('btnWithdraw');
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = 'confirm in wallet…';
    try {
        const tx = await state.game.withdraw(state.credit);
        btn.textContent = 'withdrawing…';
        await tx.wait();
        toast('winnings withdrawn to your wallet');
    } catch (e) {
        toast(explain(e));
    } finally {
        delete btn.dataset.busy;
        btn.disabled = isRoundLive();
        await refreshCredit();
    }
}



// ─────────────────────────────────────────────────────── the deal

async function deal() {
    if (!state.game) return connect();
    if (state.phase !== PHASE.IDLE && state.phase !== PHASE.RESULT) return;
    state.picks.clear();
    state.mode = 'grid';
    state.dir = null;
    state.reveal = null;
    state.guessed = false;
    state.win = null;
    setPhase(PHASE.DEALING);

    // the table loads in its own shape while the deal confirms — we genuinely do not
    // know the window yet, and the skeleton says so without a spinner
    show('screenPlay');
    skeletonTable();
    txOpen('confirm in your wallet…');
    syncBets();

    try {
        const anteWei = parseEther(String(state.ante));
        // whatever credit doesn't cover rides along as value — no separate deposit
        const tx = await state.game.startRound(anteWei, {value: shortfall(anteWei)});
        txSet('confirmed — finding your chart…');
        const rcpt = await tx.wait();

        // the window is only knowable from the receipt
        const ev = rcpt.logs
            .map((l) => {
                try { return state.game.interface.parseLog(l); } catch { return null; }
            })
            .find((p) => p && p.name === 'RoundDealt');
        if (!ev) throw new Error('RoundDealt not found in receipt');

        state.roundId = ev.args.roundId;
        // The window is drawn from the hash of the block AFTER the deal, which does not exist yet.
        // That is the point: a contract used to call startRound, read the window it drew and revert
        // the whole transaction if it did not like it, reverse-searching for free. Now there is
        // nothing to read at deal time, so the ante is unavoidable.
        txSet('picking your chart…');
        const wid = (await deriveWindow(state.roundId, rcpt.blockHash)).toLowerCase();
        state.win = await fetchWindow(wid);

        await refreshCredit();
        txClose();
        populateTable();                         // real content lands under the intro overlay
        await riddleIntro(state.win.riddle);     // typed centre-stage, then glides to its slot
        armClock();                              // only now does decision time start
    } catch (e) {
        txClose();
        toast(explain(e));
        setPhase(PHASE.IDLE);
        show('screenLobby');
    loadHudStats();
    }
}

/** Everything visible on the table, but no clock — the riddle intro plays over this. */
function populateTable() {
    const w = state.win;
    clearSkeleton();
    $('riddleText').textContent = w.riddle;
    $('guessInput').value = '';
    $('guessResult').textContent = '';
    $('anchorPrice').textContent = '$' + w.anchorPrice.toLocaleString(undefined, {maximumFractionDigits: 2});
    renderStake();

    buildGrid();
    layoutGrid();
    $('modeGrid').classList.add('on');
    $('modeSimple').classList.remove('on');
    $('paneGrid').hidden = false;
    $('paneSimple').hidden = true;
    $('gridOverlay').classList.remove('dimmed');
    syncBets();

    // canvas must be measured after it is visible
    drawChart();
    setTimeout(drawChart, 60);
    window.addEventListener('resize', () => { layoutGrid(); drawChart(); }, {passive: true});
}

/** Decision time begins here, never during the ceremony. */
function armClock() {
    setPhase(PHASE.BETTING);
    startClock();
}

function startClock() {
    clearInterval(state.timer);
    state.deadline = Date.now() + DECISION_SECONDS * 1000;
    const tick = () => {
        const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        const el = $('clock');
        el.textContent = left;
        el.classList.toggle('urgent', left <= 10);
        if (left <= 0) {
            clearInterval(state.timer);
            if (state.phase !== PHASE.BETTING) return;   // already signing; let it finish
            if (state.picks.size > 0) lockIn();
            else showDeadEnd('time up — no bets placed, so your stake is forfeit');
        }
    };
    tick();
    state.timer = setInterval(tick, 250);
}

// ─────────────────────────────────────────────────────── betting

/** Keep the cell overlay aligned to the same x-axis the canvas uses. */
function layoutGrid() {
    const w = state.win;
    if (!w) return;
    const lead = w.leadSteps ?? 0;
    const totalSteps = w.visible.length + lead + w.timeSteps - 1;
    const startFrac = (w.visible.length - 1 + lead) / totalSteps;
    $('gridOverlay').style.width = `${(1 - startFrac) * 100}%`;
}

function buildGrid() {
    const w = state.win;
    const ov = $('gridOverlay');
    ov.style.gridTemplateColumns = `repeat(${w.timeSteps},1fr)`;
    ov.style.gridTemplateRows = `repeat(${w.priceBands},1fr)`;
    ov.innerHTML = '';
    for (let row = 0; row < w.priceBands; row++) {
        const p = w.priceBands - 1 - row;
        for (let t = 0; t < w.timeSteps; t++) {
            const cell = w.grid.find((c) => c.t === t && c.p === p);
            const el = document.createElement('div');
            el.className = 'cell';
            el.dataset.key = `${t}:${p}`;
            el.dataset.mult = cell ? cell.m : 0;
            el.textContent = cell ? fmtMult(cell.m) : '';
            el.onclick = () => togglePick(t, p, cell ? cell.m : 0);
            ov.appendChild(el);
        }
    }
}

const fmtMult = (m) => (m >= 100 ? Math.round(m) + 'x' : m.toFixed(m < 10 ? 2 : 1) + 'x');

function togglePick(t, p, mult) {
    if (state.phase !== PHASE.BETTING) return;
    const key = `${t}:${p}`;
    if (state.picks.has(key)) {
        state.picks.delete(key);
    } else {
        const budget = state.maxExposure > 0 ? state.maxExposure : Infinity;
        const maxHere = Math.min(budget / mult, state.maxBet || Infinity);
        if (state.stake > maxHere) {
            toast(`${fmtMult(mult)} cell takes at most ${maxHere.toFixed(2)} CTC — lower your stake`);
            return;
        }
        state.picks.set(key, {t, p, mult, stake: state.stake});
    }
    syncBets();
}

// both modes settle through the same result screen, so these have to answer for either
const dirMult = () => (state.dir ? DIR_MULT.up : DIR_MULT.down);
const totalStaked = () =>
    state.mode === 'simple'
        ? (state.dir === null ? 0 : state.stake)
        : [...state.picks.values()].reduce((a, b) => a + b.stake, 0);
const maxWin = () =>
    state.mode === 'simple'
        ? (state.dir === null ? 0 : state.stake * dirMult())
        : [...state.picks.values()].reduce((a, b) => a + b.stake * b.mult, 0);

function syncBets() {
    if (state.mode === 'simple') return syncSimple();
    // A cell's max stake is exposureCap / multiplier. Long-shot cells can therefore take far
    // less than the ante, which is exactly what stranded early testers: they picked a 250x
    // cell, the contract refused, and the clock ate the ante. Mark them up front.
    const budget = state.maxExposure > 0 ? state.maxExposure : Infinity;
    // [data-key] excludes skeleton cells, which are placeholders with nothing to price
    document.querySelectorAll('.cell[data-key]').forEach((el) => {
        el.classList.toggle('picked', state.picks.has(el.dataset.key));
        const [t, p] = el.dataset.key.split(':').map(Number);
        const cell = state.win?.grid.find((c) => c.t === t && c.p === p);
        if (!cell) return;
        const maxHere = Math.min(budget / cell.m, state.maxBet || Infinity);
        el.classList.toggle('unaffordable', !state.picks.has(el.dataset.key) && state.stake > maxHere);
        el.title = `max ${maxHere < 1 ? maxHere.toFixed(2) : maxHere.toFixed(1)} CTC on this cell`;
    });
    const list = $('betList');
    if (state.picks.size === 0) {
        list.innerHTML = '<p class="muted">Tap cells on the grid →</p>';
    } else {
        list.innerHTML = '';
        for (const [key, b] of state.picks) {
            const row = document.createElement('div');
            row.className = 'bet-row';
            row.innerHTML = `<span>t${b.t} · band ${b.p}</span><b>${fmtMult(b.mult)}</b><span>${b.stake}</span>`;
            const x = document.createElement('button');
            x.textContent = '×';
            x.onclick = (e) => { e.stopPropagation(); state.picks.delete(key); syncBets(); };
            row.appendChild(x);
            list.appendChild(row);
        }
    }
    const staked = totalStaked();
    const worst = maxWin();
    $('totalStaked').textContent = staked.toFixed(2);
    $('maxWin').textContent = worst.toFixed(1);

    // Three constraints, all enforced on-chain — surfaced here so players never hit a
    // confusing revert. The exposure cap is the surprising one: a 250x cell can only carry
    // cap/250 CTC, which may be LESS than the ante, so bets sometimes must be spread.
    const overBet = [...state.picks.values()].some((b) => b.stake > state.maxBet);
    const overExposure = state.maxExposure > 0 && worst > state.maxExposure;
    const underAnte = staked < state.ante;

    const btn = $('btnLockIn');
    $('maxWin').classList.toggle('over', overExposure);
    btn.disabled = state.picks.size === 0 || underAnte || overExposure || overBet;

    if (state.picks.size === 0) btn.textContent = 'pick some cells';
    else if (overBet) btn.textContent = `max ${state.maxBet.toFixed(1)} CTC per cell`;
    else if (overExposure) btn.textContent = `spread out — max win over ${state.maxExposure.toFixed(0)} CTC`;
    else if (underAnte) btn.textContent = `stake at least ${state.ante} CTC`;
    else btn.textContent = 'lock in bets';
}

/** syncBets for the two-button game. Same limits, one bet. */
function syncSimple() {
    const mult = state.dir === null ? 0 : state.dir ? DIR_MULT.up : DIR_MULT.down;
    const staked = state.dir === null ? 0 : state.stake;
    const worst = staked * mult;

    $('totalStaked').textContent = staked.toFixed(2);
    $('maxWin').textContent = worst.toFixed(1);

    const overBet = staked > state.maxBet;
    const overExposure = state.maxExposure > 0 && worst > state.maxExposure;
    const underAnte = state.dir !== null && staked < state.ante;

    $('maxWin').classList.toggle('over', overExposure);
    for (const id of ['dirUp', 'dirDown']) $(id).disabled = state.phase !== PHASE.BETTING;

    const btn = $('btnLockIn');
    btn.disabled = state.dir === null || underAnte || overExposure || overBet;
    if (state.dir === null) btn.textContent = 'pick up or down';
    else if (overBet) btn.textContent = `max ${state.maxBet.toFixed(1)} CTC`;
    else if (overExposure) btn.textContent = `stake lower — max win over ${state.maxExposure.toFixed(0)} CTC`;
    else if (underAnte) btn.textContent = `stake at least ${state.ante} CTC`;
    else btn.textContent = `lock in ${state.dir ? 'up' : 'down'} · ${state.stake} CTC`;
}

// ─────────────────────────────────────────────────────── bet mode

/**
 * Switch between the grid and the two-button game.
 *
 * Only reachable while BETTING, and it clears the other mode's selection — a round settles one
 * way or the other on-chain, so letting both hold picks would show a max-win that cannot happen.
 */
function setMode(mode) {
    if (state.phase !== PHASE.BETTING) return;
    state.mode = mode;
    state.picks.clear();
    state.dir = null;

    $('modeGrid').classList.toggle('on', mode === 'grid');
    $('modeSimple').classList.toggle('on', mode === 'simple');
    $('modeGrid').setAttribute('aria-selected', String(mode === 'grid'));
    $('modeSimple').setAttribute('aria-selected', String(mode === 'simple'));
    $('paneGrid').hidden = mode !== 'grid';
    $('paneSimple').hidden = mode === 'grid';
    $('gridOverlay').classList.toggle('dimmed', mode === 'simple');

    $('oddsNote').innerHTML = mode === 'grid'
        ? 'Prices depend only on <strong>how far from the last known price</strong> a cell sits — never on the hidden path.'
        : 'Up pays less because the pool drifts up: <strong>54%</strong> of windows close higher. Beat 59% on your up calls and the edge is yours.';

    document.querySelectorAll('.cell.picked').forEach((el) => el.classList.remove('picked'));
    syncBets();
}

function pickDirection(up) {
    if (state.phase !== PHASE.BETTING) return;
    state.dir = state.dir === up ? null : up;   // tapping the same side again clears it
    $('dirUp').classList.toggle('on', state.dir === true);
    $('dirDown').classList.toggle('on', state.dir === false);
    syncBets();
}

// ─────────────────────────────────────────────────────── settle + resolve

async function lockIn() {
    // The button and the expiring clock can both call this. Without a guard the player signs
    // twice and the second transaction reverts on an already-settled round.
    // The button and the expiring clock can both reach here; only one may proceed.
    if (state.phase !== PHASE.BETTING) return;
    if (state.mode === 'simple' ? state.dir === null : state.picks.size === 0) return;
    setPhase(PHASE.SETTLING);
    clearInterval(state.timer);

    const bets = [...state.picks.values()];
    const ts = bets.map((b) => b.t);
    const ps = bets.map((b) => b.p);
    const amts = bets.map((b) => parseEther(String(b.stake)));
    const simple = state.mode === 'simple';

    $('btnLockIn').disabled = true;
    txOpen('confirm your bets…');

    try {
        // the contract deducts (totalStake - ante); attach whatever credit doesn't cover
        const anteWei = parseEther(String(state.ante));
        const stakeWei = simple ? parseEther(String(state.stake)) : amts.reduce((a, b) => a + b, 0n);
        const extra = stakeWei > anteWei ? stakeWei - anteWei : 0n;
        const tx = simple
            ? await state.game.settleDirection(state.roundId, state.dir, stakeWei, {value: shortfall(extra)})
            : await state.game.settleRound(state.roundId, ts, ps, amts, {value: shortfall(extra)});
        txSet('locking your bets on-chain…');
        const settleRcpt = await tx.wait();
        state.settleBlock = settleRcpt.blockNumber;
        await refreshCredit();

        state.reveal = await fetchReveal(state.win.windowId, state.roundId);
        txClose();
        setPhase(PHASE.REVEALING);
        const won = await animateReveal();
        // The reveal already told the player exactly what they won — the on-chain resolve only
        // moves the money. Waiting for it would put a ~30s "settling…" screen between the
        // outcome and the result, so it runs behind the result instead.
        settleInBackground();
        finish(won);
    } catch (e) {
        // A failed settle leaves the round Dealt on-chain with the ante committed. Say so
        // plainly and give a way out, rather than stranding the player on a dead table.
        showDeadEnd(explain(e));
    }
}

/** Round can't continue — explain why and offer the only useful action. */
function showDeadEnd(message) {
    clearInterval(state.timer);
    setPhase(PHASE.RESULT);   // nothing is at stake any more; let the player out
    txError(message, () => {
        setPhase(PHASE.IDLE);
        show('screenLobby');
    loadHudStats();
    });
}

async function animateReveal() {
    const bands = state.reveal.outcome;
    const shown = [];
    let running = 0;

    // walk the runway first — it is drawn, it just decides nothing
    for (const c of state.reveal.runway ?? []) {
        await new Promise((r) => setTimeout(r, 300));
        shown.push(c);
        drawPartial(shown);
    }

    for (let t = 0; t < state.win.timeSteps; t++) {
        await new Promise((r) => setTimeout(r, 420));
        shown.push(state.reveal.hidden[t]);
        drawPartial(shown);

        const landed = bands[t]?.p;
        document.querySelectorAll(`.cell[data-key^="${t}:"]`).forEach((el) => {
            const p = Number(el.dataset.key.split(':')[1]);
            const bet = state.picks.get(`${t}:${p}`);
            const isLanded = p === landed;

            // Three distinct states. Previously every cell in the landed band turned green,
            // so a whole row lit up as if it had won even where nothing was staked.
            if (isLanded) el.classList.add('landed'); // where the price actually went
            if (bet && isLanded) {
                el.classList.add('won');
                const payout = bet.stake * bet.mult;
                running += payout;
                el.innerHTML = `<span class="cell-badge">+${payout.toFixed(1)}</span>`;
            } else if (bet) {
                el.classList.add('lost');
                el.innerHTML = `<span class="cell-badge">−${bet.stake.toFixed(1)}</span>`;
            }
        });

        // live running total so the player can see it going right or wrong as it unfolds
        const net = running - totalStaked();
        const rt = $('runningTotal');
        if (rt) {
            rt.textContent = (net >= 0 ? '+' : '') + net.toFixed(2);
            rt.className = 'running ' + (net > 0 ? 'up' : net < 0 ? 'down' : '');
        }
    }
    await new Promise((r) => setTimeout(r, 600));
    return running;
}

/**
 * Settles the payout without blocking the player.
 *
 * resolveRound is permissionless — it checks Merkle proofs, not callers — so the keeper can do
 * it and the player never signs a third time. Two blocks pass before the money lands (one for
 * the resolve to be legal, one to mine it), which is why this must not be awaited.
 *
 * Best effort, never the only path: if the keeper is down the round stays claimable by anyone,
 * including the player, and the claim affordance appears on the result screen.
 */
async function settleInBackground() {
    const roundId = state.roundId;
    try {
        const r = await fetch('/api/resolve', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({roundId: String(roundId)}),
        });
        if (!r.ok) throw new Error('keeper declined');
        await refreshCredit();
        return;
    } catch (e) {
        offerManualClaim(roundId);
    }
}

/** A keeper outage must never look like a lost round. The money is still the player's. */
function offerManualClaim(roundId) {
    const box = $('resultActions') || $('btnAgain')?.parentElement;
    if (!box || box.querySelector('.claim-fallback')) return;
    const b = document.createElement('button');
    b.className = 'ghost claim-fallback';
    b.textContent = 'claim winnings manually';
    b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'claiming…';
        try {
            await claimManually(roundId);
            b.remove();
        } catch (e) {
            b.disabled = false;
            b.textContent = 'claim winnings manually';
            toast('claim failed: ' + explain(e));
        }
    };
    box.appendChild(b);
}

/** The player signs it themselves. Same call the keeper makes; only the payer differs. */
async function claimManually(roundId) {
    const h = state.reveal.hidden;
    try {
        await nextBlock(state.settleBlock);
        const tx = await state.game.resolveRound(
            roundId,
            h.map((c) => c.index),
            h.map((c) => c.b),
            h.map((c) => BigInt(c.sqrtPriceX96)),
            h.map((c) => c.proof),
        );
        await tx.wait();
        await refreshCredit();
    } finally {
        /* caller reports failure; the round stays claimable either way */
    }
}

function finish(payout) {
    const staked = totalStaked();
    const net = payout - staked;
    const bands = state.reveal.outcome;

    $('resultVerdict').textContent = net > 0 ? 'you read it right' : 'wrong side of history';
    $('resultVerdict').className = 'verdict ' + (net > 0 ? 'won' : 'lost');
    $('resultAmount').textContent = (net >= 0 ? '+' : '') + net.toFixed(2) + ' CTC';
    $('resultAmount').className = 'amount ' + (net > 0 ? 'up' : net < 0 ? 'down' : '');
    $('resultEra').innerHTML = `This was <strong>${state.reveal.eraLabel}</strong>.<br />${state.win.riddle}`;

    if (state.mode === 'simple') {
        // the direction is decided by the FINAL candle against the anchor, not by any band
        const closed = state.reveal.hidden[state.reveal.hidden.length - 1].c;
        const wentUp = closed > state.win.anchorPrice;
        const right = wentUp === state.dir;
        $('resultBreakdown').innerHTML =
            `<div><span>you said ${state.dir ? 'up' : 'down'} @ ${dirMult().toFixed(2)}×</span>` +
            `<span class="${right ? 'w' : 'l'}">${right ? '+' + payout.toFixed(2) : '−' + staked.toFixed(1)}</span></div>` +
            `<div><span>closed ${wentUp ? 'above' : 'below'} $${state.win.anchorPrice.toFixed(2)}</span>` +
            `<span>$${closed.toFixed(2)}</span></div>`;
        recordScore(state.reveal.eraLabel, net);
        setPhase(PHASE.RESULT);
        show('screenResult');
        return;
    }

    $('resultBreakdown').innerHTML = [...state.picks.values()]
        .map((b) => {
            const hit = bands[b.t]?.p === b.p;
            const pay = hit ? b.stake * b.mult : 0;
            return `<div><span>t${b.t} · band ${b.p} @ ${fmtMult(b.mult)}</span>` +
                `<span class="${hit ? 'w' : 'l'}">${hit ? '+' + pay.toFixed(2) : '−' + b.stake.toFixed(1)}</span></div>`;
        })
        .join('');

    recordScore(state.reveal.eraLabel, net);
    setPhase(PHASE.RESULT);
    show('screenResult');
}

// ─────────────────────────────────────────────────────── chart

function drawChart() {
    const cv = $('chart');
    const w = state.win;
    if (!w) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    if (rect.width === 0) return;
    cv.width = rect.width * dpr;
    cv.height = rect.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const visible = w.visible.map((c) => c.c);
    // runway candles are part of the drawn path but were never bettable
    const revealed = state.reveal
        ? [...(state.reveal.runway ?? []).map((c) => c.c), ...state.reveal.hidden.map((c) => c.c)]
        : [];

    const half = (w.priceBands / 2) * w.bandHeight;
    const lo = w.anchorPrice * (1 - half);
    const hi = w.anchorPrice * (1 + half);
    // The path travels `leadSteps` before the grid begins, so the x-axis carries three
    // sections: the visible run, the runway, then the bettable columns. The grid overlay is
    // positioned from these same numbers (see layoutGrid) so pixels and cells cannot drift.
    const lead = w.leadSteps ?? 0;
    const totalSteps = w.visible.length + lead + w.timeSteps - 1;
    const gridLeft = ((w.visible.length - 1 + lead) / totalSteps) * W;

    const X = (i) => (i / totalSteps) * W;
    const Y = (p) => H - ((p - lo) / (hi - lo)) * H;

    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let b = 0; b <= w.priceBands; b++) {
        const price = lo + (b / w.priceBands) * (hi - lo);
        ctx.beginPath(); ctx.moveTo(gridLeft, Y(price)); ctx.lineTo(W, Y(price)); ctx.stroke();
    }

    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = palette('--hairline-strong');
    ctx.beginPath(); ctx.moveTo(0, Y(w.anchorPrice)); ctx.lineTo(W, Y(w.anchorPrice)); ctx.stroke();
    ctx.setLineDash([]);

    const line = (pts, offset, color, width) => {
        if (!pts.length) return;
        ctx.beginPath();
        pts.forEach((p, i) => { const x = X(i + offset), y = Y(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke();
    };

    // Blue is chrome — it marks the candles you were given. The revealed path is white, the
    // brightest thing on screen, because it is the new information. Neither is ever green or
    // red: those belong to the grid cells, where they answer "did my bet win?".
    line(visible, 0, palette('--blue'), 2.4);
    if (revealed.length) line([visible[visible.length - 1], ...revealed], visible.length - 1, palette('--ink'), 2.4);

    const headVal = revealed.length ? revealed[revealed.length - 1] : visible[visible.length - 1];
    const headIdx = revealed.length ? visible.length - 1 + revealed.length : visible.length - 1;
    ctx.beginPath();
    ctx.arc(X(headIdx), Y(headVal), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = revealed.length ? palette('--ink') : palette('--blue');
    ctx.fill();
}

function drawPartial(shown) {
    const full = state.reveal;
    // `shown` already accumulates runway THEN outcome, so blank the runway here or drawChart
    // would prepend it a second time and the line would double back on itself
    state.reveal = {...full, runway: [], hidden: shown};
    drawChart();
    state.reveal = full;
}

// ─────────────────────────────────────────────────────── guess

function checkGuess() {
    if (state.guessed || !state.win) return;
    const g = $('guessInput').value.trim().toLowerCase();
    if (!g) return;
    // the answer lives in the reveal file, so pre-commit we can only check the year loosely
    const el = $('guessResult');
    state.pendingGuess = g;
    el.textContent = `locked in "${g}" — checked at reveal`;
    el.className = 'guess-result';
    state.guessed = true;
}

// ─────────────────────────────────────────────────────── leaderboard

const LB_KEY = 'wen.leaderboard';
/** Pre-rename key. Read as a fallback so the rename doesn't silently bin anyone's best hands. */
const LB_KEY_LEGACY = 'hindsight.leaderboard';

function readBoard() {
    const raw = localStorage.getItem(LB_KEY) ?? localStorage.getItem(LB_KEY_LEGACY);
    try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function recordScore(era, net) {
    let board = readBoard();
    const entry = {era, net: Number(net.toFixed(2)), at: Date.now()};
    board.push(entry);
    board.sort((a, b) => b.net - a.net);
    board = board.slice(0, 10);
    localStorage.setItem(LB_KEY, JSON.stringify(board));
    renderLeaderboard(entry);
}

function renderLeaderboard(justPlayed) {
    const board = readBoard();
    const ol = $('leaderboard');
    if (!ol) return;
    if (!board.length) { ol.innerHTML = '<div class="empty">no rounds yet</div>'; return; }
    ol.innerHTML = board
        .map((e) => {
            const mine = justPlayed && e.at === justPlayed.at;
            return `<li class="${mine ? 'you' : ''}"><span>${e.era.split('—')[0].trim()}</span>` +
                `<b class="${e.net < 0 ? 'neg' : ''}">${e.net >= 0 ? '+' : ''}${e.net}</b></li>`;
        })
        .join('');
}

// ─────────────────────────────────────────────────────── controls

function wireControls() {
    $('btnConnect').onclick = connect;
    $('btnConnectBig').onclick = connect;
    $('btnFaucet').onclick = claimFaucet;
    $('btnWithdraw').onclick = doWithdraw;
    $('btnDeal').onclick = deal;
    $('tourSkip').onclick = () => tour.finish();
    $('tourNext').onclick = () => tour.next();
    $('tourReplay').onclick = () => tour.start(true);
    $('btnLockIn').onclick = lockIn;
    $('modeGrid').onclick = () => setMode('grid');
    $('modeSimple').onclick = () => setMode('simple');
    $('dirUp').onclick = () => pickDirection(true);
    $('dirDown').onclick = () => pickDirection(false);
    $('btnAgain').onclick = () => { setPhase(PHASE.IDLE); refreshFaucet(); show('screenLobby'); };
    $('btnGuess').onclick = checkGuess;
    $('guessInput').addEventListener('keydown', (e) => e.key === 'Enter' && checkGuess());

    document.querySelectorAll('[data-stake]').forEach((btn) => {
        btn.onclick = () => setStakeIdx(state.stakeIdx + (btn.dataset.stake === '+' ? 1 : -1));
    });

    $('txDialog').addEventListener('cancel', (e) => e.preventDefault());

    window.ethereum?.on?.('accountsChanged', () => location.reload());
    window.ethereum?.on?.('chainChanged', () => location.reload());
}

/* ═══════════════════════ guided first run ═══════════════════════
 *
 * Steps advance on the REAL action — claiming, picking, betting — not on a "next" button. Clicking
 * through explanations is the passive pattern that does not stick, and this game has to be learned
 * by hand or the 45s clock eats the player alive on their first round.
 *
 * The one thing that shapes the whole design: step 3 cannot happen during a live round. The
 * decision window is DECISION_BLOCKS on-chain and cannot be paused, so a modal tour over a real
 * board would burn the player's stake while they read. The grid is therefore taught on a rigged
 * practice board first, and the real round is left unguided.
 */
const TOUR_KEY = 'wen.tour.v1';
const MARK_PATHS = {
    idle:     'M12 54 L36 72 L60 30 L86 60 L112 26',
    pointing: 'M12 60 L34 66 L58 44 L84 52 L114 30',
    thinking: 'M12 50 L40 46 L68 54 L96 47 L118 50',
    won:      'M12 66 L36 72 L60 46 L84 58 L118 12',
};

const tour = {
    steps: [], i: -1, live: null, on: false,

    /** Re-runnable: the lobby keeps a link so a player can ask for it again. */
    start(force) {
        if (!force && localStorage.getItem(TOUR_KEY)) return;
        // A funded wallet does not need to be walked to the faucet.
        const needsCTC = (state.wallet ?? 0n) < parseEther('1');
        this.steps = TOUR_STEPS.filter((s) => s.id !== 'faucet' || needsCTC);
        this.i = -1;
        this.on = true;
        $('tour').hidden = false;
        this.next();
        addEventListener('resize', this._reflow);
        addEventListener('scroll', this._reflow, true);
    },

    next() {
        const prev = this.steps[this.i];
        if (prev?.onExit) prev.onExit();
        this.i++;
        const s = this.steps[this.i];
        if (!s) return this.finish();
        this.show(s);
        if (s.onEnter) s.onEnter();
    },

    show(s) {
        $('tourStep').textContent = `step ${this.i + 1} of ${this.steps.length}`;
        $('tourText').textContent = s.text;
        $('tourPop').querySelector('.line').setAttribute('d', MARK_PATHS[s.mark ?? 'pointing']);
        replay($('tourPop').querySelector('.wen-mark'));   // re-trigger the draw on every step

        const go = $('tourGo'), wait = $('tourWait');
        go.hidden = !s.cta;
        if (s.cta) { go.textContent = s.cta; go.onclick = () => (s.act ? s.act() : this.next()); }
        // A step with no button is waiting on the player. Say so — an empty button row reads as a
        // broken tour, which is exactly how the stake step was first reported.
        wait.hidden = !!s.cta;
        if (!s.cta) wait.querySelector('em').textContent = s.waiting ?? 'waiting for you';
        // A waiting step still needs a way forward. Doing the real thing is the point, but the
        // player must not be stuck with "skip the whole tutorial" as their only other option —
        // especially on the stake step, where a default is already selected.
        $('tourNext').hidden = !!s.cta;
        // Nothing left to skip on the last step — its own button already ends the tour, so an
        // "skip tutorial" beside it is just a second way to do the same thing.
        $('tourSkip').hidden = this.i === this.steps.length - 1;

        this.spot(s.target ? $(s.target) : null);
    },

    /** Move the spotlight and park the popover beside it. */
    spot(el) {
        this.live?.classList.remove('tour-live');
        this.live = el;
        const spot = $('tourSpot'), pop = $('tourPop');
        if (!el) {
            // No target: collapse the hole to nothing but KEEP the element, because its outward
            // box-shadow is what dims the page. Setting opacity:0 here removed the dimming too.
            spot.style.cssText = 'width:0;height:0;border:none;top:50%;left:50%';
            pop.style.top = '50%'; pop.style.left = '50%';
            pop.style.transform = 'translate(-50%,-50%)';
            return;
        }
        el.classList.add('tour-live');               // lift it above the dimming layer
        el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        const r = el.getBoundingClientRect(), pad = 8;
        spot.style.cssText = `opacity:1;top:${r.top - pad}px;left:${r.left - pad}px;` +
                             `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
        pop.style.transform = 'none';
        const below = r.bottom + 16;
        const fitsBelow = below + pop.offsetHeight < innerHeight - 12;
        pop.style.top = `${fitsBelow ? below : Math.max(12, r.top - pop.offsetHeight - 16)}px`;
        pop.style.left = `${Math.min(Math.max(12, r.left), innerWidth - pop.offsetWidth - 12)}px`;
    },

    _reflow: () => { if (tour.on && tour.live) tour.spot(tour.live); },

    /** Called from the real handlers. A step only advances when its own action happens. */
    notify(evt) {
        if (!this.on) return;
        if (this.steps[this.i]?.advanceOn === evt) this.next();
    },

    finish() {
        this.on = false;
        this.live?.classList.remove('tour-live');
        this.live = null;
        $('tour').hidden = true;
        localStorage.setItem(TOUR_KEY, '1');
        removeEventListener('resize', this._reflow);
        removeEventListener('scroll', this._reflow, true);
    },
};

/** Restart a CSS animation on a cloned-free element. */
function replay(el) {
    el.querySelectorAll('.line, .wen-head').forEach((n) => {
        n.style.animation = 'none';
        void n.offsetWidth;                          // force reflow so the animation re-runs
        n.style.animation = '';
    });
}

const TOUR_STEPS = [
    {
        id: 'welcome', mark: 'idle', cta: "show me",
        text: 'You are dealt a real slice of Ethereum, never told when it is, and you bet on what ' +
              'happened next. Sixty seconds and you will know how.',
    },
    {
        id: 'faucet', target: 'btnFaucet', mark: 'pointing', advanceOn: 'faucet:landed',
        waiting: 'waiting for your CTC to land',
        text: 'You have no CTC. Claim 20 from the faucet — gas is covered, so a brand-new wallet ' +
              'works. It takes about fifteen seconds to land.',
    },
    {
        id: 'stake', target: 'anteGrid', mark: 'pointing', advanceOn: 'ante:picked',
        waiting: 'tap a stake to continue',
        text: 'Pick your opening stake. It is a minimum, not a fee — it counts toward your bets, ' +
              'so playing honestly costs you nothing extra. Tap any amount to continue — including ' +
              'the one already highlighted.',
    },
    {
        id: 'dry', mark: 'thinking', cta: 'try a practice board',
        text: 'The grid sits over the future. Cells the real price path crosses pay out, and the ' +
              'further from the last known price, the more they pay. Have a go with nothing at stake.',
        act: () => dryRun.open(),
        advanceOn: 'dry:done',
    },
    {
        id: 'deal', target: 'btnDeal', mark: 'won', cta: 'got it',
        text: 'That is the whole game. Once you start, the chart appears and the 45 second clock ' +
              'is live — so read the riddle first, then bet. Good luck.',
    },
];

/* ── the practice board ──
 * Six columns, five rows, no chain behind it. The path is generated AFTER the player picks so it
 * crosses one of their cells: this is a lesson, not a wager, and a first session that rewards you
 * is the one you come back to. The header says "nothing at stake" for exactly that reason — the
 * rigging is disclosed, not hidden.
 */
const DRY_COLS = 6, DRY_ROWS = 5;
const DRY_MULT = [25, 7, 1, 7, 25];              // by row, mirrored around the middle

const dryRun = {
    picks: new Set(), path: null,

    open() {
        this.picks.clear(); this.path = null;
        const g = $('dryGrid');
        g.style.gridTemplateColumns = `repeat(${DRY_COLS}, 1fr)`;
        g.style.gridTemplateRows = `repeat(${DRY_ROWS}, 1fr)`;
        g.innerHTML = '';
        for (let r = 0; r < DRY_ROWS; r++) {
            for (let c = 0; c < DRY_COLS; c++) {
                const d = document.createElement('div');
                d.className = 'dcell';
                d.textContent = `${DRY_MULT[r]}×`;
                d.onclick = () => this.pick(d, c, r);
                g.appendChild(d);
            }
        }
        $('dryPicked').textContent = '0';
        $('dryPay').textContent = '0.0';
        $('dryNote').textContent = 'pick any two cells the line might cross';
        $('dryPlay').disabled = true;
        $('dryPlay').textContent = 'play it forward';
        $('dryPlay').onclick = () => this.play();
        $('dryRun').showModal();
        this.draw([]);
    },

    pick(el, c, r) {
        if (this.path) return;                        // locked once it has played
        const key = `${c}-${r}`;
        if (this.picks.has(key)) { this.picks.delete(key); el.classList.remove('on'); }
        else { this.picks.add(key); el.classList.add('on'); }
        $('dryPicked').textContent = String(this.picks.size);
        $('dryPay').textContent = [...this.picks]
            .reduce((a, k) => a + DRY_MULT[+k.split('-')[1]], 0).toFixed(1);
        $('dryPlay').disabled = this.picks.size === 0;
        if (this.picks.size) $('dryNote').textContent = 'now play it forward and watch';
    },

    /** A path that ends up crossing one of the picked cells. */
    build() {
        const chosen = [...this.picks][Math.floor(this.picks.size / 2)].split('-').map(Number);
        const [tc, tr] = chosen;
        const rows = [];
        let r = 2;                                     // starts on the anchor row
        for (let c = 0; c < DRY_COLS; c++) {
            if (c === tc) r = tr;
            else if (c < tc) r = Math.round(2 + ((tr - 2) * c) / Math.max(1, tc));
            else r = Math.max(0, Math.min(DRY_ROWS - 1, r + (Math.random() < 0.5 ? -1 : 1)));
            rows.push(Math.max(0, Math.min(DRY_ROWS - 1, r)));
        }
        return rows;
    },

    async play() {
        if (this.path) return;
        this.path = this.build();
        $('dryPlay').disabled = true;
        $('dryNote').textContent = 'the real price path, playing forward…';
        let won = 0;
        for (let c = 0; c < DRY_COLS; c++) {
            await new Promise((res) => setTimeout(res, 260));
            this.draw(this.path.slice(0, c + 1));
            const key = `${c}-${this.path[c]}`;
            if (this.picks.has(key)) {
                const idx = this.path[c] * DRY_COLS + c;
                $('dryGrid').children[idx].classList.add('hit');
                won += DRY_MULT[this.path[c]];
            }
        }
        $('dryPay').textContent = won.toFixed(1);
        $('dryPay').className = won > 0 ? 'win' : '';
        $('dryNote').textContent = won > 0
            ? `the line crossed your cells — that would have paid ${won.toFixed(1)}×`
            : 'it missed this time. that happens — the far cells pay more for a reason.';
        const btn = $('dryPlay');
        btn.disabled = false;
        btn.textContent = 'got it';
        btn.onclick = () => { $('dryRun').close(); tour.notify('dry:done'); };
    },

    /** Straight-line chart through the row centres, drawn as far as `rows` goes. */
    draw(rows) {
        const cv = $('dryChart'), wrap = cv.parentElement;
        const dpr = devicePixelRatio || 1;
        cv.width = wrap.clientWidth * dpr; cv.height = wrap.clientHeight * dpr;
        const x = cv.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        x.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
        if (!rows.length) return;
        const cw = wrap.clientWidth / DRY_COLS, ch = wrap.clientHeight / DRY_ROWS;
        x.strokeStyle = getComputedStyle(document.body).getPropertyValue('--blue').trim() || '#4976ff';
        x.lineWidth = 2.5; x.lineJoin = 'round'; x.lineCap = 'round';
        x.beginPath();
        x.moveTo(0, 2.5 * ch + ch / 2);
        rows.forEach((r, c) => x.lineTo(c * cw + cw / 2, r * ch + ch / 2));
        x.stroke();
    },
};

// Local-only test handle. The tour advances on real on-chain events, which cannot be produced
// against a dev server, so stepping through it by hand needs a way in. Guarded by hostname so it
// never exists in production.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    window.__wen = {tour, dryRun, step: (id) => {
        tour.i = tour.steps.findIndex((s) => s.id === id) - 1;
        tour.next();
    }};
}
