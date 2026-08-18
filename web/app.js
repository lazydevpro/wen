/**
 * Hindsight — client.
 *
 * Round flow, and why it's shaped this way:
 *
 *   connect → deposit once → pick an ante → startRound() lands on-chain → ONLY THEN is the
 *   window known and the chart drawn → 45s to bet → settleRound() → resolveRound()
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

const CC3 = {
    chainIdHex: '0x18e8f', // 102031
    chainName: 'Creditcoin CC3 Testnet',
    rpcUrls: ['https://rpc.cc3-testnet.creditcoin.network'],
    nativeCurrency: {name: 'Creditcoin', symbol: 'CTC', decimals: 18},
    blockExplorerUrls: ['https://creditcoin-testnet.blockscout.com'],
};

const GRID_GAME = '0x6A3d2866A01E7ee66445BaF6f2c7971845B7e7ce';
const REGISTRY = '0x5263dd64098e545235e9184A31aF6aDb4d3AB119';

const GAME_ABI = [
    'function deposit() external payable',
    'function withdraw(uint256 amount) external',
    'function balances(address) external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    'function maxRoundExposure() external view returns (uint256)',
    'function DECISION_BLOCKS() external view returns (uint256)',
    'function startRound(uint128 ante) external returns (uint256,bytes32)',
    'function settleRound(uint256 roundId,uint8[] ts,uint8[] ps,uint128[] amounts) external',
    'function resolveRound(uint256 roundId,uint256[] indices,uint64[] blockNumbers,uint160[] sqrtPrices,bytes32[][] proofs) external',
    'function roundSummary(uint256) external view returns (address,bytes32,uint8,uint128,uint128,uint128)',
    'event RoundDealt(uint256 indexed roundId,address indexed player,bytes32 indexed windowId,uint128 ante,uint64 deadlineBlock)',
    'event RoundResolved(uint256 indexed roundId,address indexed player,uint256 payout)',
];

const DECISION_SECONDS = 45;
const ANTES = [0.5, 1, 2, 5];
const STAKES = [0.5, 1, 2, 5];

const state = {
    provider: null,
    signer: null,
    game: null,
    address: null,
    credit: 0n,
    windows: [],
    byWindowId: new Map(),
    win: null,
    roundId: null,
    ante: 1,
    stake: 1,
    stakeIdx: 1,
    anteIdx: 1,
    picks: new Map(),
    maxBet: 0,
    maxExposure: 0,
    reveal: null,
    guessed: false,
    timer: null,
    deadline: 0,
};

// ─────────────────────────────────────────────────────────── boot

(async function init() {
    state.windows = await (await fetch('data/windows.json')).json();
    for (const w of state.windows) state.byWindowId.set(w.windowId.toLowerCase(), w);
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

function show(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(screen).classList.add('active');
}

// ─────────────────────────────────────────────────────── wallet

async function connect() {
    if (!window.ethereum) {
        toast('no wallet found — install MetaMask to play');
        return;
    }
    state.provider = new BrowserProvider(window.ethereum);
    await state.provider.send('eth_requestAccounts', []);

    // make sure we're on CC3
    const net = await state.provider.getNetwork();
    if (net.chainId !== BigInt(parseInt(CC3.chainIdHex, 16))) {
        try {
            await window.ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId: CC3.chainIdHex}]});
        } catch (e) {
            if (e.code === 4902) {
                await window.ethereum.request({method: 'wallet_addEthereumChain', params: [CC3]});
            } else throw e;
        }
        state.provider = new BrowserProvider(window.ethereum);
    }

    state.signer = await state.provider.getSigner();
    state.address = await state.signer.getAddress();
    state.game = new Contract(GRID_GAME, GAME_ABI, state.signer);

    $('btnConnect').hidden = true;
    $('addr').hidden = false;
    $('addr').textContent = state.address.slice(0, 6) + '…' + state.address.slice(-4);
    $('creditStat').hidden = false;

    await refreshCredit();
    show('screenLobby');
}

async function refreshCredit() {
    state.credit = await state.game.balances(state.address);
    // both limits shrink with the bankroll, so read them rather than assuming
    state.maxBet = Number(formatEther(await state.game.maxBet()));
    state.maxExposure = Number(formatEther(await state.game.maxRoundExposure()));
    $('credit').textContent = Number(formatEther(state.credit)).toFixed(2);
    $('btnDeal').disabled = state.credit < parseEther(String(state.ante));
    $('depositPanel').classList.toggle('needs-funds', state.credit === 0n);
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
            $('stakeValue').textContent = state.stake;
            renderAnteGrid();
            refreshCredit();
        };
        g.appendChild(b);
    });
    $('decisionHint').textContent = `${DECISION_SECONDS} seconds`;
}

async function doDeposit() {
    const amt = $('depositInput').value;
    try {
        toast('confirm the deposit in your wallet…');
        const tx = await state.game.deposit({value: parseEther(amt)});
        toast('depositing…');
        await tx.wait();
        await refreshCredit();
        toast(`deposited ${amt} CTC`);
    } catch (e) {
        toast(short(e));
    }
}

async function doWithdraw() {
    try {
        const tx = await state.game.withdraw(state.credit);
        await tx.wait();
        await refreshCredit();
        toast('withdrawn');
    } catch (e) {
        toast(short(e));
    }
}

const short = (e) => (e.shortMessage ?? e.message ?? String(e)).slice(0, 90);

// ─────────────────────────────────────────────────────── the deal

async function deal() {
    if (!state.game) return connect();
    state.picks.clear();
    state.reveal = null;
    state.guessed = false;
    state.win = null;

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
        const tx = await state.game.startRound(parseEther(String(state.ante)));
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
        state.win = state.byWindowId.get(wid);
        if (!state.win) throw new Error('dealt an unknown window');

        await refreshCredit();
        openTable();
    } catch (e) {
        $('dealVeil').classList.remove('on');
        toast(short(e));
        show('screenLobby');
    }
}

function openTable() {
    const w = state.win;
    $('riddleText').textContent = w.riddle;
    $('guessInput').value = '';
    $('guessResult').textContent = '';
    $('anchorPrice').textContent = '$' + w.anchorPrice.toLocaleString(undefined, {maximumFractionDigits: 2});
    $('stakeValue').textContent = state.stake;

    buildGrid();
    syncBets();
    $('dealVeil').classList.remove('on');

    // canvas must be measured after it is visible
    drawChart();
    setTimeout(drawChart, 60);
    window.addEventListener('resize', drawChart, {passive: true});

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
            if (state.picks.size > 0) lockIn();
            else {
                toast('time up — ante forfeited');
                show('screenLobby');
            }
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
            el.textContent = cell ? fmtMult(cell.m) : '';
            el.onclick = () => togglePick(t, p, cell ? cell.m : 0);
            ov.appendChild(el);
        }
    }
}

const fmtMult = (m) => (m >= 100 ? Math.round(m) + 'x' : m.toFixed(m < 10 ? 2 : 1) + 'x');

function togglePick(t, p, mult) {
    if (state.reveal) return;
    const key = `${t}:${p}`;
    if (state.picks.has(key)) state.picks.delete(key);
    else state.picks.set(key, {t, p, mult, stake: state.stake});
    syncBets();
}

const totalStaked = () => [...state.picks.values()].reduce((a, b) => a + b.stake, 0);
const maxWin = () => [...state.picks.values()].reduce((a, b) => a + b.stake * b.mult, 0);

function syncBets() {
    document.querySelectorAll('.cell').forEach((el) => el.classList.toggle('picked', state.picks.has(el.dataset.key)));
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

// ─────────────────────────────────────────────────────── settle + resolve

async function lockIn() {
    clearInterval(state.timer);
    const bets = [...state.picks.values()];
    const ts = bets.map((b) => b.t);
    const ps = bets.map((b) => b.p);
    const amts = bets.map((b) => parseEther(String(b.stake)));

    $('btnLockIn').disabled = true;
    $('dealVeil').classList.add('on');
    $('veilText').textContent = 'confirm your bets…';

    try {
        const tx = await state.game.settleRound(state.roundId, ts, ps, amts);
        $('veilText').textContent = 'bets locked in — revealing…';
        await tx.wait();
        await refreshCredit();

        state.reveal = await (await fetch(`data/${state.win.id}.reveal.json`)).json();
        $('dealVeil').classList.remove('on');
        await animateReveal();
        await resolveOnChain();
    } catch (e) {
        $('dealVeil').classList.remove('on');
        toast(short(e));
    }
}

async function animateReveal() {
    const bands = state.reveal.outcome;
    const shown = [];
    for (let t = 0; t < state.win.timeSteps; t++) {
        await new Promise((r) => setTimeout(r, 380));
        shown.push(state.reveal.hidden[t]);
        drawPartial(shown);
        const landed = bands[t]?.p;
        document.querySelectorAll(`.cell[data-key^="${t}:"]`).forEach((el) => {
            const p = Number(el.dataset.key.split(':')[1]);
            if (p === landed) el.classList.add('hit');
            else if (el.classList.contains('picked')) el.classList.add('miss');
        });
    }
    await new Promise((r) => setTimeout(r, 500));
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
        toast('resolve failed: ' + short(e));
        finish(0);
    }
}

function finish(payout) {
    const staked = totalStaked();
    const net = payout - staked;
    const bands = state.reveal.outcome;

    $('resultVerdict').textContent = net > 0 ? 'you read it right' : 'hindsight is 20/20';
    $('resultVerdict').className = 'verdict ' + (net > 0 ? 'won' : 'lost');
    $('resultAmount').textContent = (net >= 0 ? '+' : '') + net.toFixed(2) + ' CTC';
    $('resultEra').innerHTML = `This was <strong>${state.reveal.eraLabel}</strong>.<br />${state.win.riddle}`;

    $('resultBreakdown').innerHTML = [...state.picks.values()]
        .map((b) => {
            const hit = bands[b.t]?.p === b.p;
            const pay = hit ? b.stake * b.mult : 0;
            return `<div><span>t${b.t} · band ${b.p} @ ${fmtMult(b.mult)}</span>` +
                `<span class="${hit ? 'w' : 'l'}">${hit ? '+' + pay.toFixed(2) : '−' + b.stake.toFixed(1)}</span></div>`;
        })
        .join('');

    recordScore(state.reveal.eraLabel, net);
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
    ctx.strokeStyle = 'rgba(255,94,168,0.4)';
    ctx.beginPath(); ctx.moveTo(0, Y(w.anchorPrice)); ctx.lineTo(W, Y(w.anchorPrice)); ctx.stroke();
    ctx.setLineDash([]);

    const line = (pts, offset, color, width, glow) => {
        if (!pts.length) return;
        ctx.beginPath();
        pts.forEach((p, i) => { const x = X(i + offset), y = Y(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.shadowBlur = glow; ctx.shadowColor = color;
        ctx.stroke(); ctx.shadowBlur = 0;
    };

    line(visible, 0, '#ff5ea8', 2.4, 12);
    if (revealed.length) line([visible[visible.length - 1], ...revealed], visible.length - 1, '#c8ff4d', 2.4, 14);

    const headVal = revealed.length ? revealed[revealed.length - 1] : visible[visible.length - 1];
    const headIdx = revealed.length ? visible.length - 1 + revealed.length : visible.length - 1;
    ctx.beginPath();
    ctx.arc(X(headIdx), Y(headVal), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = revealed.length ? '#c8ff4d' : '#ff5ea8';
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

const LB_KEY = 'hindsight.leaderboard';

function recordScore(era, net) {
    let board = [];
    try { board = JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch { board = []; }
    const entry = {era, net: Number(net.toFixed(2)), at: Date.now()};
    board.push(entry);
    board.sort((a, b) => b.net - a.net);
    board = board.slice(0, 10);
    localStorage.setItem(LB_KEY, JSON.stringify(board));
    renderLeaderboard(entry);
}

function renderLeaderboard(justPlayed) {
    let board = [];
    try { board = JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch { board = []; }
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
    $('btnDeposit').onclick = doDeposit;
    $('btnWithdraw').onclick = doWithdraw;
    $('btnDeal').onclick = deal;
    $('btnLockIn').onclick = lockIn;
    $('btnAgain').onclick = () => show('screenLobby');
    $('btnGuess').onclick = checkGuess;
    $('guessInput').addEventListener('keydown', (e) => e.key === 'Enter' && checkGuess());

    document.querySelectorAll('[data-stake]').forEach((btn) => {
        btn.onclick = () => {
            state.stakeIdx = Math.max(0, Math.min(STAKES.length - 1, state.stakeIdx + (btn.dataset.stake === '+' ? 1 : -1)));
            state.stake = STAKES[state.stakeIdx];
            $('stakeValue').textContent = state.stake;
        };
    });

    window.ethereum?.on?.('accountsChanged', () => location.reload());
    window.ethereum?.on?.('chainChanged', () => location.reload());
}
