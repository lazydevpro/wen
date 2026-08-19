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
import {BrowserProvider, Contract, formatEther, parseEther} from 'https://esm.sh/ethers@6.17.0';

const $ = (id) => document.getElementById(id);

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

const GRID_GAME = '0x1BF8d7f54Dda5699dA359B4AECfa6bA7582909cC';
const REGISTRY = '0x5156A5BD8F3304eCE58c12F097B98C11600ba2A5';

const GAME_ABI = [
    'function deposit() external payable',
    'function withdraw(uint256 amount) external',
    'function balances(address) external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    'function maxRoundExposure() external view returns (uint256)',
    'function DECISION_BLOCKS() external view returns (uint256)',
    'function startRound(uint128 ante) external payable returns (uint256,bytes32)',
    'function settleRound(uint256 roundId,uint8[] ts,uint8[] ps,uint128[] amounts) external payable',
    'function settleDirection(uint256 roundId,bool up,uint128 stake) external payable',
    'function DIRECTION_UP_MULT() external view returns (uint32)',
    'function DIRECTION_DOWN_MULT() external view returns (uint32)',
    'event DirectionSettled(uint256 indexed roundId,address indexed player,bool up,uint256 staked,uint256 maxPayout)',
    'function resolveRound(uint256 roundId,uint256[] indices,uint64[] blockNumbers,uint160[] sqrtPrices,bytes32[][] proofs) external',
    'function roundSummary(uint256) external view returns (address,bytes32,uint8,uint128,uint128,uint128)',
    'function deadlineOf(uint256) external view returns (uint256)',
    'event RoundDealt(uint256 indexed roundId,address indexed player,bytes32 indexed windowId,uint128 ante,uint64 deadlineBlock)',
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
];

/** Turn a revert into something a player can act on. */
function explain(e) {
    const name = e?.revert?.name ?? e?.info?.error?.data?.name;
    const args = e?.revert?.args ?? [];
    switch (name) {
        case 'DecisionWindowClosed':
            return 'too slow — the decision window closed and the ante is forfeit';
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
            return 'the table is paused (bankroll drawdown breaker)';
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
    DEALING: 'dealing',     // ante submitted, window not yet known
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
    if (window.ethereum?.selectedAddress) connect().catch(() => {});
})();

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
        };
        g.appendChild(b);
    });
    $('decisionHint').textContent = `${DECISION_SECONDS} seconds`;
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
async function fetchWindow(windowId) {
    const r = await fetch(`data/w/${windowId}.json`);
    if (!r.ok) throw new Error('dealt a window this client does not have');
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
    } catch (e) {
        out.className = 'guess-result faucet-result-no';
        out.textContent = '✗ ' + (e.message ?? e);
    } finally {
        refreshFaucet();
    }
}

async function doWithdraw() {
    if (state.credit === 0n) return;
    try {
        toast('confirm the withdrawal in your wallet…');
        const tx = await state.game.withdraw(state.credit);
        await tx.wait();
        await refreshCredit();
        toast('winnings withdrawn to your wallet');
    } catch (e) {
        toast(explain(e));
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

    // show the play screen with the chart hidden — the veil is the honest bit:
    // we genuinely do not know the window yet.
    show('screenPlay');
    $('dealVeil').classList.add('on');
    $('veilText').textContent = 'confirm the ante in your wallet…';
    $('riddleText').textContent = '…';
    $('clock').textContent = '—';
    $('gridOverlay').innerHTML = '';
    syncBets();

    try {
        const anteWei = parseEther(String(state.ante));
        // whatever credit doesn't cover rides along as value — no separate deposit
        const tx = await state.game.startRound(anteWei, {value: shortfall(anteWei)});
        $('veilText').textContent = 'ante on-chain — dealing…';
        const rcpt = await tx.wait();

        // the window is only knowable from the receipt
        const ev = rcpt.logs
            .map((l) => {
                try { return state.game.interface.parseLog(l); } catch { return null; }
            })
            .find((p) => p && p.name === 'RoundDealt');
        if (!ev) throw new Error('RoundDealt not found in receipt');

        state.roundId = ev.args.roundId;
        const wid = ev.args.windowId.toLowerCase();
        state.win = await fetchWindow(wid);

        await refreshCredit();
        openTable();
    } catch (e) {
        $('dealVeil').classList.remove('on');
        toast(explain(e));
        setPhase(PHASE.IDLE);
        show('screenLobby');
    }
}

function openTable() {
    const w = state.win;
    $('riddleText').textContent = w.riddle;
    $('guessInput').value = '';
    $('guessResult').textContent = '';
    $('anchorPrice').textContent = '$' + w.anchorPrice.toLocaleString(undefined, {maximumFractionDigits: 2});
    renderStake();

    buildGrid();
    $('modeGrid').classList.add('on');
    $('modeSimple').classList.remove('on');
    $('paneGrid').hidden = false;
    $('paneSimple').hidden = true;
    $('gridOverlay').classList.remove('dimmed');
    syncBets();
    $('dealVeil').classList.remove('on');

    // canvas must be measured after it is visible
    drawChart();
    setTimeout(drawChart, 60);
    window.addEventListener('resize', drawChart, {passive: true});

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
            else showDeadEnd('time up — no bets placed, so the ante is forfeit');
        }
    };
    tick();
    state.timer = setInterval(tick, 250);
}

// ─────────────────────────────────────────────────────── betting

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
    document.querySelectorAll('.cell').forEach((el) => {
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
        ? 'Multipliers come from the <strong>visible</strong> candles only — the odds cannot leak the hidden path.'
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
    $('dealVeil').classList.add('on');
    $('veilText').textContent = 'confirm your bets…';

    try {
        // the contract deducts (totalStake - ante); attach whatever credit doesn't cover
        const anteWei = parseEther(String(state.ante));
        const stakeWei = simple ? parseEther(String(state.stake)) : amts.reduce((a, b) => a + b, 0n);
        const extra = stakeWei > anteWei ? stakeWei - anteWei : 0n;
        const tx = simple
            ? await state.game.settleDirection(state.roundId, state.dir, stakeWei, {value: shortfall(extra)})
            : await state.game.settleRound(state.roundId, ts, ps, amts, {value: shortfall(extra)});
        $('veilText').textContent = 'bets locked in — revealing…';
        await tx.wait();
        await refreshCredit();

        state.reveal = await fetchReveal(state.win.windowId, state.roundId);
        $('dealVeil').classList.remove('on');
        setPhase(PHASE.REVEALING);
        await animateReveal();
        await resolveOnChain();
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
    $('dealVeil').classList.add('on');
    $('veilText').innerHTML =
        `<strong style="color:var(--red)">${message}</strong><br /><br />` +
        `<button id="btnBail" class="ghost">back to the table</button>`;
    document.querySelector('.spinner')?.setAttribute('style', 'display:none');
    setTimeout(() => {
        const b = $('btnBail');
        if (b) b.onclick = () => {
            document.querySelector('.spinner')?.removeAttribute('style');
            $('dealVeil').classList.remove('on');
            setPhase(PHASE.IDLE);
            show('screenLobby');
        };
    }, 0);
}

async function animateReveal() {
    const bands = state.reveal.outcome;
    const shown = [];
    let running = 0;

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
}

/** Resolution is permissionless — the client does it so the whole loop is visible on-chain. */
async function resolveOnChain() {
    const h = state.reveal.hidden;
    try {
        const tx = await state.game.resolveRound(
            state.roundId,
            h.map((c) => c.index),
            h.map((c) => c.b),
            h.map((c) => BigInt(c.sqrtPriceX96)),
            h.map((c) => c.proof),
        );
        const rcpt = await tx.wait();
        const ev = rcpt.logs
            .map((l) => { try { return state.game.interface.parseLog(l); } catch { return null; } })
            .find((p) => p && p.name === 'RoundResolved');
        const payout = ev ? Number(formatEther(ev.args.payout)) : 0;
        await refreshCredit();
        finish(payout);
    } catch (e) {
        toast('resolve failed: ' + explain(e));
        finish(0);
    }
}

function finish(payout) {
    const staked = totalStaked();
    const net = payout - staked;
    const bands = state.reveal.outcome;

    $('resultVerdict').textContent = net > 0 ? 'you read it right' : 'wrong side of history';
    $('resultVerdict').className = 'verdict ' + (net > 0 ? 'won' : 'lost');
    $('resultAmount').textContent = (net >= 0 ? '+' : '') + net.toFixed(2) + ' CTC';
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
    const revealed = state.reveal ? state.reveal.hidden.map((c) => c.c) : [];

    const half = (w.priceBands / 2) * w.bandHeight;
    const lo = w.anchorPrice * (1 - half);
    const hi = w.anchorPrice * (1 + half);
    const totalSteps = w.visible.length + w.timeSteps - 1;
    const gridLeft = W * 0.42;

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
    state.reveal = {...full, hidden: shown};
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
    if (!board.length) { ol.innerHTML = '<div class="empty">no hands yet</div>'; return; }
    ol.innerHTML = board
        .map((e) => {
            const mine = justPlayed && e.at === justPlayed.at;
            return `<li class="${mine ? 'you' : ''}"><span>${e.era.split('—')[0].trim()}</span>` +
                `<b>${e.net >= 0 ? '+' : ''}${e.net}</b></li>`;
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

    window.ethereum?.on?.('accountsChanged', () => location.reload());
    window.ethereum?.on?.('chainChanged', () => location.reload());
}
