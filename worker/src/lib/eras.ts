/**
 * The era catalogue the window pool is generated from.
 *
 * Six windows made the game harvestable: settle six minimum rounds and you own every answer
 * forever. The fix is depth, so each era here is sliced into several non-overlapping windows
 * (see bulk-windows.ts), which multiplies the pool without inventing anything.
 *
 * Two rules for adding an era:
 *
 *  1. `riddle` names the era through WHAT HAPPENED, never when. The whole game is inferring the
 *     date, so a riddle containing a year is a bug.
 *  2. Only real, checkable events. A riddle for an event that did not happen is worse than no
 *     riddle — a player who knows the history would be actively misled. This list therefore
 *     stops at the end of 2024 rather than padding the count with vaguer recent stretches.
 *
 * Eras are anchored to DATES, not block numbers. Block times changed at the Merge (~13.2s to
 * exactly 12s), so a block number hardcoded from a date estimate drifts by weeks across the
 * 2021-2024 range. `resolveEraBlocks()` binary-searches real timestamps instead.
 */
export interface EraSpec {
    id: string;
    label: string;
    /** ISO date the era opens; resolved to a block at build time. */
    date: string;
    /** Populated by resolveEraBlocks(). */
    startBlock: number;
    riddle: string;
    /** accepted for the era guess, lowercase substrings */
    answers: string[];
}

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Riddles for slices that are not near their era's anchor event.
 *
 * A slice eight weeks after the Luna collapse is not the Luna collapse, and captioning it with
 * that riddle would actively mislead a player who knows the history — the riddle is the clue, so
 * a false one is worse than a vague one. These claim nothing that did not happen.
 */
const QUIET_RIDDLES = [
    'wen no headline marks the stretch, and the tape is all you get?',
    'wen nothing made the news, but it happened anyway?',
    'wen there was no crisis, no launch, no announcement — only price?',
    'wen history remembers nothing, but the chain recorded everything?',
    'wen an ordinary week — someone still buying, someone still selling?',
    'wen you have to read it, because nobody remembers it?',
];

/** Stable pick, so relabelling the same window twice gives the same riddle. */
function quietRiddleFor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return QUIET_RIDDLES[h % QUIET_RIDDLES.length];
}

const MONTH_ANSWER = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i;
/** "May 2022 — Luna collapses" -> "Luna collapses" */
const themeOf = (label: string) => label.split('—').slice(1).join('—').trim() || label;

/**
 * Label, riddle and accepted answers for one slice, given the date it actually starts.
 *
 * A slice keeps its era's headline only while it still covers that headline. Beyond that it
 * becomes an honest unnamed stretch: the month and year are always truthful, because that is
 * what the guess is actually checked against.
 */
export function sliceMeta(era: EraSpec, id: string, when: Date) {
    const year = when.getUTCFullYear();
    const month = MONTHS[when.getUTCMonth()];
    const anchor = new Date(`${era.date}T00:00:00Z`);
    const daysOut = Math.abs(when.getTime() - anchor.getTime()) / 86_400_000;
    const onEra = daysOut <= 21;

    const answers = new Set<string>([
        String(year),
        `${month.slice(0, 3).toLowerCase()} ${year}`,
        `${month.toLowerCase()} ${year}`,
        // era keywords (luna, ftx, merge…) only apply while the slice is actually on the event
        ...(onEra ? era.answers.filter((a) => !MONTH_ANSWER.test(a) && a !== String(year)) : []),
    ]);

    return {
        label: onEra ? `${month} ${year} — ${themeOf(era.label)}` : `${month} ${year}`,
        riddle: onEra ? era.riddle : quietRiddleFor(id),
        answers: [...answers],
        onEra,
    };
}

export const ERAS: EraSpec[] = [
    {
        id: 'gas-crisis-2021',
        label: 'May 2021 — peak gas',
        date: '2021-05-12',
        startBlock: 0,
        riddle: 'wen the chain worked fine, but nobody could afford to use it?',
        answers: ['2021', 'may 2021', 'gas'],
    },
    {
        id: 'london-2021',
        label: 'August 2021 — the London fork',
        date: '2021-08-05',
        startBlock: 0,
        riddle: 'wen the chain started burning a piece of every fee it collected?',
        answers: ['2021', 'aug 2021', 'august 2021', 'london', '1559', 'burn'],
    },
    {
        id: 'pre-ath-2021',
        label: 'October 2021 — the run to the all-time high',
        date: '2021-10-05',
        startBlock: 0,
        riddle: 'wen everything was going up, and everyone agreed it would keep going up?',
        answers: ['2021', 'oct 2021', 'october 2021', 'bull'],
    },
    {
        id: 'ath-2021',
        label: 'November 2021 — the top',
        date: '2021-11-08',
        startBlock: 0,
        riddle: 'wen it would never be this high again — and nobody knew it yet?',
        answers: ['2021', 'nov 2021', 'november 2021', 'ath', 'top', 'peak'],
    },
    {
        id: 'newyear-2022',
        label: 'January 2022 — the turn',
        date: '2022-01-10',
        startBlock: 0,
        riddle: 'wen the new year quietly took back what the old one had given?',
        answers: ['2022', 'jan 2022', 'january 2022'],
    },
    {
        id: 'spring-2022',
        label: 'March 2022 — the last bounce',
        date: '2022-03-14',
        startBlock: 0,
        riddle: 'wen a recovery everyone wanted to believe in did not last?',
        answers: ['2022', 'mar 2022', 'march 2022'],
    },
    {
        id: 'luna-2022',
        label: 'May 2022 — Luna collapses',
        date: '2022-05-08',
        startBlock: 0,
        riddle: 'wen something that promised to always be worth a dollar stopped being worth a dollar?',
        answers: ['2022', 'may 2022', 'luna', 'terra', 'ust'],
    },
    {
        id: 'celsius-2022',
        label: 'June 2022 — lenders freeze',
        date: '2022-06-12',
        startBlock: 0,
        riddle: 'wen a lender that advertised withdrawals at any time stopped allowing them?',
        answers: ['2022', 'jun 2022', 'june 2022', 'celsius', '3ac'],
    },
    {
        id: 'merge-2022',
        label: 'September 2022 — the Merge',
        date: '2022-09-13',
        startBlock: 0,
        riddle: 'wen the way blocks got made changed forever, and the price barely noticed?',
        answers: ['2022', 'sep 2022', 'september 2022', 'merge', 'pos'],
    },
    {
        id: 'ftx-2022',
        label: 'November 2022 — FTX collapses',
        date: '2022-11-06',
        startBlock: 0,
        riddle: 'wen an exchange everyone trusted turned out to be holding nothing at all?',
        answers: ['2022', 'nov 2022', 'november 2022', 'ftx', 'sbf', 'alameda'],
    },
    {
        id: 'bottom-2022',
        label: 'December 2022 — capitulation',
        date: '2022-12-18',
        startBlock: 0,
        riddle: 'wen almost everyone had left, and the few still here were very quiet?',
        answers: ['2022', 'dec 2022', 'december 2022', 'bottom', 'capitulation'],
    },
    {
        id: 'svb-2023',
        label: 'March 2023 — the USDC depeg',
        date: '2023-03-10',
        startBlock: 0,
        riddle: 'wen a token backed by dollars found out where those dollars were deposited?',
        answers: ['2023', 'mar 2023', 'march 2023', 'usdc', 'svb', 'depeg', 'bank'],
    },
    {
        id: 'shapella-2023',
        label: 'April 2023 — Shapella',
        date: '2023-04-12',
        startBlock: 0,
        riddle: 'wen the coins locked up to secure the chain could finally come back out?',
        answers: ['2023', 'apr 2023', 'april 2023', 'shapella', 'shanghai', 'withdrawals'],
    },
    {
        id: 'sec-2023',
        label: 'June 2023 — the regulator moves',
        date: '2023-06-05',
        startBlock: 0,
        riddle: 'wen the regulator sued the two largest exchanges in the same week?',
        answers: ['2023', 'jun 2023', 'june 2023', 'sec', 'binance', 'coinbase'],
    },
    {
        id: 'quiet-2023',
        label: 'September 2023 — the quiet',
        date: '2023-09-08',
        startBlock: 0,
        riddle: 'wen nothing happened, loudly, for weeks on end?',
        answers: ['2023', 'sep 2023', 'september 2023', 'quiet', 'chop'],
    },
    {
        id: 'anticipation-2023',
        label: 'December 2023 — pricing it in early',
        date: '2023-12-01',
        startBlock: 0,
        riddle: 'wen the market bid up something that had not been approved yet?',
        answers: ['2023', 'dec 2023', 'december 2023'],
    },
    {
        id: 'etf-jan-2024',
        label: 'January 2024 — the spot ETF approval',
        date: '2024-01-10',
        startBlock: 0,
        riddle: 'wen the regulator finally said yes to the thing it refused for a decade?',
        answers: ['2024', 'jan 2024', 'january 2024', 'etf'],
    },
    {
        id: 'etf-2024',
        label: 'March 2024 — Dencun and the highs',
        date: '2024-03-13',
        startBlock: 0,
        riddle: 'wen Wall Street finally got a wrapper it was allowed to buy?',
        answers: ['2024', 'mar 2024', 'march 2024', 'etf', 'dencun', 'blobs'],
    },
    {
        id: 'eth-etf-2024',
        label: 'July 2024 — the second wrapper',
        date: '2024-07-22',
        startBlock: 0,
        riddle: 'wen the other big asset got the same wrapper, to much less noise?',
        answers: ['2024', 'jul 2024', 'july 2024', 'eth etf', 'etf'],
    },
    {
        id: 'carry-2024',
        label: 'August 2024 — the carry unwind',
        date: '2024-08-04',
        startBlock: 0,
        riddle: 'wen an interest rate across the world moved, and everything sold at once?',
        answers: ['2024', 'aug 2024', 'august 2024', 'yen', 'carry', 'crash'],
    },
    {
        id: 'election-2024',
        label: 'November 2024 — the election',
        date: '2024-11-05',
        startBlock: 0,
        riddle: 'wen a vote counted entirely off-chain moved this chart more than anything on it?',
        answers: ['2024', 'nov 2024', 'november 2024', 'election'],
    },
];
