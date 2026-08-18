# Single-surface UI — spec

**Status:** proposed, not implemented
**Goal:** one persistent table instead of four screens, with faucet / deposit / ante as dialogs.

## The problem, stated precisely

`web/index.html` has four `<section class="screen">` blocks and swaps them by toggling `.active`.
That is not really four pages — it is one application wearing four costumes, and the costume
change loses context every time. Concretely:

- Placing a bet and topping up your credit are the same activity, but live on different screens.
- The result screen replaces the chart you just played, exactly when you most want to look at it.
- The chart area is the whole point of the app and is visible in only one of the four states.

## Research

**Native `<dialog>` is the right primitive, and no focus-trap library is needed.**
`showModal()` is Baseline "widely available" (all major browsers since March 2022, ~96% global).
It puts the dialog in the top layer, renders a `::backdrop`, and makes every other element in the
document `inert` — which handles click-blocking, focus containment and screen-reader hiding in one
call. `show()` and the bare `open` attribute give *none* of this and must not be used here.

Verified on the live deployment rather than assumed — `HTMLDialogElement`, `showModal`, `closedBy`,
`inert`, `::backdrop` and top-layer rendering all present, including correct rendering inside our
`overflow: hidden` / `100dvh` body (the top layer escapes the clip).

Notably, focus does **not** need to be trapped: the W3C APA working group concluded `showModal()`
need not trap focus, and tabbing out to browser chrome is correct behaviour, not a bug. So the
custom trap this would otherwise need is simply not written.

**The APG modal pattern requires** focus to move into the dialog on open, Escape to close, and
focus to return to the invoking element on close. `showModal()` gives the first two; the third is
ours to implement (browsers restore focus in most cases, but it is not guaranteed across the
dynamic-content cases we have).

**Modals are appropriate only when interaction outside genuinely is prevented.** This is the hinge
of the whole design — see below.

Sources: [WAI-ARIA APG modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/),
[MDN `showModal()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal),
[MDN `<dialog>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog),
[CSS-Tricks: no need to trap focus on a dialog](https://css-tricks.com/there-is-no-need-to-trap-focus-on-a-dialog-element/),
[W3C Understanding SC 2.2.1](https://www.w3.org/TR/UNDERSTANDING-WCAG20/time-limits-required-behaviors.html).

## The constraint that actually drives the design

**A modal opening during a live round can cost the player their ante.**

The clock at `app.js:447` is destructive. On expiry it either locks in whatever is selected or
forfeits the ante outright:

```js
if (left <= 0) {
    if (state.settling) return;
    if (state.picks.size > 0) lockIn();
    else showDeadEnd('time up — no bets placed, so the ante is forfeit');
}
```

`showModal()` makes the background `inert`. A dialog opening at 40s therefore makes the betting
grid unclickable while a clock that forfeits real value keeps counting down. That is not a polish
issue; it is a way to lose money by clicking the wrong button.

So the rule is not "add dialogs carefully". The rule is:

> **No dialog may be open while a round is live.** Every dialog-opening control is disabled for
> the entire duration of a round, and `openDialog()` refuses regardless of what the UI shows.

This also settles the WCAG SC 2.2.1 question. The 45s limit is essential — it is the
anti-reverse-search mechanism, and it is enforced on-chain by `DECISION_BLOCKS`, so it cannot be
extended client-side anyway. What we must not do is *add* a way for the interface itself to consume
that time. Worth recording: the on-chain deadline is ~5 minutes, so the 45s client clock is a
product choice, not a chain limit. It could be raised later without touching the contract.

## The real architectural problem underneath

The round lifecycle is currently implicit, spread across four unrelated flags — `state.settling`,
`state.reveal`, `state.timer`, `state.win` — and re-derived ad hoc wherever a guard is needed:

```js
if (state.reveal || state.settling) return;   // app.js:491, "are we still betting?"
if (state.settling) return;                   // app.js:568, the same question, different answer
```

Adding dialogs to that is how you get the ante-losing bug above, because "may a dialog open right
now?" has no single place to be answered. **This is the change worth making; dialogs are the
occasion for it, not the substance.**

### Explicit phase machine

```
        connect            deal tx           receipt          bets sent        proofs
IDLE ─────────────▶ IDLE ──────────▶ DEALING ────────▶ BETTING ────────▶ SETTLING ────────▶ REVEALING
  ▲                                     │                  │                                    │
  │                                     │ reverted         │ timeout, no bets                   │
  │                                     ▼                  ▼                                    ▼
  └──────────────────────────────── IDLE ◀───────── DEAD-END ◀──────────────────────────── RESULT
                                                   (ante forfeit)
```

```js
const PHASE = {IDLE: 'idle', DEALING: 'dealing', BETTING: 'betting',
               SETTLING: 'settling', REVEALING: 'revealing', RESULT: 'result'};

/** The single source of truth for "is a round in flight?". */
const DIALOGS_ALLOWED = new Set([PHASE.IDLE, PHASE.RESULT]);
const canOpenDialog = () => DIALOGS_ALLOWED.has(state.phase);
```

Every existing ad-hoc guard collapses into a phase check, and the timer, veil and control
disabled-states all become functions of one variable.

## What becomes a dialog — and what does not

| Surface | Today | Proposed | Why |
| --- | --- | --- | --- |
| Faucet | lobby panel | **dialog** | Infrequent, needs explanation, has its own result state. Textbook modal. |
| Deposit / withdraw | lobby panel | **dialog** | Infrequent, involves a transaction, benefits from focus. |
| Ante + deal | lobby panel | **dialog** | A commitment of real value; a deliberate confirm step is appropriate. See trade-off. |
| Result | full screen | **dialog over the table** | Strict improvement: you see the revealed chart *behind* your result instead of losing it. |
| Connect wallet | full screen | **not a dialog** | The wallet extension already opens its own modal. A dialog to summon a dialog is noise — a topbar button and an empty-state CTA. |
| Deal veil | in-canvas overlay | **unchanged** | A busy indicator, not a dialog. It must *not* be `inert`-ing anything, and it is correct as-is. |
| Riddle / grid / chart | play screen | **the persistent surface** | This is the application. |

### The one genuine trade-off: ante as a dialog

Modal dialogs are for infrequent or critical actions; dealing is the *most* frequent action in the
app, and a dialog on every round adds a click to the core loop. Mitigation, which I think makes it
a net win rather than a tax:

- The ante is remembered between rounds and preselected, with the confirm button autofocused, so a
  repeat deal is `Enter`.
- The idle table's primary CTA reads `deal · 1 CTC` and opens the dialog pre-committed to that
  amount; a smaller `change ante` opens it focused on the selector.

If it still feels heavy in practice, the fallback is to deal directly from the CTA and keep the
dialog only for changing the ante. Worth deciding after using it, not before.

## Idle state of the table

With one persistent surface, the chart area needs an honest empty state before the first deal. It
must **not** render a real window — that would leak a chart from the pool. Proposal: the grid
renders as an empty lattice with no multipliers, the riddle panel shows the rules, and the chart
area holds the primary CTA.

## Implementation phases

Each phase leaves the app working and is independently verifiable.

1. **Phase machine, no visual change.** Introduce `state.phase`, replace every ad-hoc guard, assert
   invariants. The UI still has four screens. Verifiable: full round still plays, guards behave.
2. **Dialog shell.** Add `<dialog>` elements, an `openDialog()` / `closeDialog()` pair enforcing
   `canOpenDialog()` and focus restoration, plus `::backdrop` styling. Move the faucet in first —
   lowest risk, no transaction on the critical path.
3. **Deposit dialog.** Same pattern, now with a transaction.
4. **Single surface.** Collapse connect/lobby into the table's idle state; ante dialog; delete the
   `screenConnect` and `screenLobby` sections.
5. **Result dialog.** Result becomes a dialog over the revealed chart; delete `screenResult`.

## Acceptance criteria

- [ ] No dialog can be opened in `dealing`, `betting`, `settling` or `revealing` — enforced in
      `openDialog()`, not only by disabling buttons. Tested by calling it directly mid-round.
- [ ] Escape closes a dialog; focus returns to the control that opened it.
- [ ] A full round plays end to end: deal → bet → settle → resolve → result.
- [ ] The 45s clock is never obscured or blocked while it is running.
- [ ] No page scroll on any state at 1280×800 and 375×812 (the existing constraint holds).
- [ ] The revealed chart stays visible behind the result.
- [ ] Grid cells remain reachable by keyboard; dialogs do not strand focus.
- [ ] No window data is rendered before a deal.

## Risks

- **Regression in the round loop.** The betting path is the one place real value is at stake.
  Mitigated by phase 1 landing separately, with a real round played before and after.
- **Mobile viewport.** Dialogs plus `100dvh` and the on-screen keyboard (the deposit input) need
  checking on a real narrow viewport, not just a resized desktop one.
- **Scope.** This touches all three web files. It is a refactor of a working, deployed game, and
  the game currently works. Phases 1–3 are safe and independently valuable; 4–5 are the visible
  change and should only land once 1–3 are verified.
