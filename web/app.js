/**
 * Hindsight — client.
 *
 * The chart is drawn to <canvas> as pixels. No numeric price series is ever placed in the DOM,
 * so a naive scraper cannot lift the data out of the page. That is friction, not security:
 * GridGame is the real enforcement, since resolution requires Merkle inclusion proofs against
 * the root committed at window registration.
 */

const $ = (id) => document.getElementById(id);
const state = {
    windows: [],
    win: null,
    reveal: null,
    picks: new Map(), // "t:p" -> {t,p,mult,stake}
    stake: 10,
    balance: 1000,
    guessed: false,
};

const STAKES = [5, 10, 25, 50, 100];
let stakeIdx = 1;

// ───────────────────────────────────────────────────────── boot

(async function init() {
    state.windows = await (await fetch('data/windows.json')).json();
    renderWindowGrid();
    wireControls();
})();

function toast(msg, ms = 2200) {
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

// ───────────────────────────────────────────────── era select

function renderWindowGrid() {
    const grid = $('windowGrid');
    grid.innerHTML = '';
    for (const w of state.windows) {
        const card = document.createElement('div');
        card.className = 'window-card';
        card.innerHTML = `
            <canvas class="spark" width="300" height="46"></canvas>
            <div class="riddle">${w.riddle}</div>
            <div class="meta"><span>${w.poolLabel}</span><span class="locked">era hidden</span></div>`;
        card.onclick = () => openWindow(w);
        grid.appendChild(card);
        drawSpark(card.querySelector('.spark'), w.visible.map((c) => c.c));
    }
}

function drawSpark(cv, prices) {
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const lo = Math.min(...prices), hi = Math.max(...prices), rng = hi - lo || 1;
    const x = (i) => (i / (prices.length - 1)) * w;
    const y = (p) => h - 6 - ((p - lo) / rng) * (h - 12);

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,94,168,0.35)');
    g.addColorStop(1, 'rgba(255,94,168,0)');
    ctx.beginPath();
    prices.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p)) : ctx.moveTo(x(i), y(p))));
    ctx.strokeStyle = '#ff5ea8';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
}

// ───────────────────────────────────────────────── play

async function openWindow(w) {
    state.win = w;
    state.picks.clear();
    state.guessed = false;
    state.reveal = null;

    $('eraChip').textContent = 'locked';
    $('riddleText').textContent = w.riddle;
    $('guessInput').value = '';
    $('guessResult').textContent = '';
    $('anchorPrice').textContent = '$' + w.anchorPrice.toLocaleString(undefined, {maximumFractionDigits: 2});

    buildGrid();
    syncBets();
    show('screenPlay');
    // Must run after the screen is visible — a display:none canvas measures 0x0.
    // Called directly rather than via requestAnimationFrame, which is throttled to
    // never in a backgrounded tab and would leave the chart blank.
    drawChart();
    setTimeout(drawChart, 60); // re-draw once fonts/layout settle
    window.addEventListener('resize', drawChart, {passive: true});
}

function buildGrid() {
    const w = state.win;
    const ov = $('gridOverlay');
    ov.style.gridTemplateColumns = `repeat(${w.timeSteps},1fr)`;
    ov.style.gridTemplateRows = `repeat(${w.priceBands},1fr)`;
    ov.innerHTML = '';

    // band 0 is the lowest price, so render rows top-down in reverse
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
    if (state.reveal) return; // locked after reveal
    const key = `${t}:${p}`;
    if (state.picks.has(key)) {
        state.picks.delete(key);
    } else {
        if (totalStaked() + state.stake > state.balance) return toast('not enough points');
        state.picks.set(key, {t, p, mult, stake: state.stake});
    }
    syncBets();
}

const totalStaked = () => [...state.picks.values()].reduce((a, b) => a + b.stake, 0);
const maxWin = () => [...state.picks.values()].reduce((a, b) => a + b.stake * b.mult, 0);

function syncBets() {
    document.querySelectorAll('.cell').forEach((el) => {
        el.classList.toggle('picked', state.picks.has(el.dataset.key));
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
    $('totalStaked').textContent = totalStaked();
    $('maxWin').textContent = Math.round(maxWin());
    $('btnPlay').disabled = state.picks.size === 0;
}

// ───────────────────────────────────────────────── chart

function drawChart() {
    const cv = $('chart');
    const w = state.win;
    if (!w) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    cv.width = rect.width * dpr;
    cv.height = rect.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);

    const visible = w.visible.map((c) => c.c);
    const revealed = state.reveal ? state.reveal.hidden.map((c) => c.c) : [];
    const all = [...visible, ...revealed];

    // vertical scale must match the band grid, so derive it from the same anchor + bandHeight
    const half = (w.priceBands / 2) * w.bandHeight;
    const lo = w.anchorPrice * (1 - half);
    const hi = w.anchorPrice * (1 + half);
    const totalSteps = w.visible.length + w.timeSteps - 1;
    const gridLeft = W * 0.42;

    const X = (i) => (i / totalSteps) * W;
    const Y = (p) => H - ((p - lo) / (hi - lo)) * H;

    // band lines under the grid area
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let b = 0; b <= w.priceBands; b++) {
        const price = lo + (b / w.priceBands) * (hi - lo);
        ctx.beginPath(); ctx.moveTo(gridLeft, Y(price)); ctx.lineTo(W, Y(price)); ctx.stroke();
    }

    // anchor line
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(255,94,168,0.4)';
    ctx.beginPath(); ctx.moveTo(0, Y(w.anchorPrice)); ctx.lineTo(W, Y(w.anchorPrice)); ctx.stroke();
    ctx.setLineDash([]);

    // proven history
    const line = (pts, offset, color, width, glow) => {
        if (pts.length === 0) return;
        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = X(i + offset), y = Y(p);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.shadowBlur = glow; ctx.shadowColor = color;
        ctx.stroke();
        ctx.shadowBlur = 0;
    };

    line(visible, 0, '#ff5ea8', 2.4, 12);
    if (revealed.length) {
        line([visible[visible.length - 1], ...revealed], visible.length - 1, '#c8ff4d', 2.4, 14);
    }

    // head dot
    const headVal = revealed.length ? revealed[revealed.length - 1] : visible[visible.length - 1];
    const headIdx = revealed.length ? visible.length - 1 + revealed.length : visible.length - 1;
    ctx.beginPath();
    ctx.arc(X(headIdx), Y(headVal), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = revealed.length ? '#c8ff4d' : '#ff5ea8';
    ctx.fill();
}

// ───────────────────────────────────────────────── reveal

async function playRound() {
    if (state.picks.size === 0) return;
    const staked = totalStaked();
    state.balance -= staked;
    $('balance').textContent = state.balance;
    $('btnPlay').disabled = true;

    // fetched only after bets are committed
    state.reveal = await (await fetch(`data/${state.win.id}.reveal.json`)).json();

    const bands = state.reveal.outcome;
    const shown = [];

    for (let t = 0; t < state.win.timeSteps; t++) {
        await new Promise((r) => setTimeout(r, 420));
        shown.push(state.reveal.hidden[t]);
        state.reveal = {...state.reveal, hidden: state.reveal.hidden};
        drawPartial(shown);

        const landed = bands[t]?.p;
        document.querySelectorAll(`.cell[data-key^="${t}:"]`).forEach((el) => {
            const p = Number(el.dataset.key.split(':')[1]);
            if (p === landed) el.classList.add('hit');
            else if (el.classList.contains('picked')) el.classList.add('miss');
        });
    }

    await new Promise((r) => setTimeout(r, 700));
    finish(staked, bands);
}

function drawPartial(shown) {
    const full = state.reveal;
    state.reveal = {...full, hidden: shown};
    drawChart();
    state.reveal = full;
}

function finish(staked, bands) {
    let won = 0;
    const rows = [];
    for (const b of state.picks.values()) {
        const hit = bands[b.t]?.p === b.p;
        const payout = hit ? b.stake * b.mult : 0;
        won += payout;
        rows.push({t: b.t, p: b.p, mult: b.mult, stake: b.stake, hit, payout});
    }

    state.balance += Math.round(won);
    $('balance').textContent = state.balance;

    const net = won - staked;
    $('resultVerdict').textContent = net > 0 ? 'you read it right' : 'hindsight is 20/20';
    $('resultVerdict').className = 'verdict ' + (net > 0 ? 'won' : 'lost');
    $('resultAmount').textContent = (net >= 0 ? '+' : '') + Math.round(net);
    $('resultEra').innerHTML = `This was <strong>${state.win.eraLabel}</strong>.<br />${state.win.riddle}`;

    $('resultBreakdown').innerHTML = rows
        .map(
            (r) =>
                `<div><span>t${r.t} · band ${r.p} @ ${fmtMult(r.mult)}</span>` +
                `<span class="${r.hit ? 'w' : 'l'}">${r.hit ? '+' + Math.round(r.payout) : '−' + r.stake}</span></div>`,
        )
        .join('');

    recordScore(state.win.eraLabel, net);
    show('screenResult');
}

// ───────────────────────────────────────────────── leaderboard

const LB_KEY = 'hindsight.leaderboard';

function recordScore(era, net) {
    let board = [];
    try { board = JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch { board = []; }
    const entry = {era, net: Math.round(net), at: Date.now()};
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
    if (board.length === 0) {
        ol.innerHTML = '<div class="empty">no runs yet</div>';
        return;
    }
    ol.innerHTML = board
        .map((e) => {
            const mine = justPlayed && e.at === justPlayed.at;
            const label = e.era.split('—')[0].trim();
            return `<li class="${mine ? 'you' : ''}"><span>${label}</span><b>${e.net >= 0 ? '+' : ''}${e.net}</b></li>`;
        })
        .join('');
}

// ───────────────────────────────────────────────── controls

function wireControls() {
    $('btnBack').onclick = () => show('screenSelect');
    $('btnAgain').onclick = () => show('screenSelect');
    $('btnPlay').onclick = playRound;

    document.querySelectorAll('[data-stake]').forEach((btn) => {
        btn.onclick = () => {
            stakeIdx = Math.max(0, Math.min(STAKES.length - 1, stakeIdx + (btn.dataset.stake === '+' ? 1 : -1)));
            state.stake = STAKES[stakeIdx];
            $('stakeValue').textContent = state.stake;
        };
    });

    $('btnGuess').onclick = checkGuess;
    $('guessInput').addEventListener('keydown', (e) => e.key === 'Enter' && checkGuess());
}

function checkGuess() {
    if (state.guessed) return;
    const g = $('guessInput').value.trim().toLowerCase();
    if (!g) return;
    const ok = state.win.answers.some((a) => g.includes(a) || a.includes(g));
    const el = $('guessResult');
    if (ok) {
        state.guessed = true;
        state.balance += 25;
        $('balance').textContent = state.balance;
        $('eraChip').textContent = state.win.eraLabel.split('—')[0].trim();
        el.textContent = '✓ correct — +25 pts. Era revealed.';
        el.className = 'guess-result ok';
        toast('+25 pts — you knew when you were');
    } else {
        el.textContent = '✗ not quite. Read the chart again.';
        el.className = 'guess-result no';
    }
}
