// The operator app's styles: Heat's design tokens and primitives (apps/web/src/app/globals.css, spec 9), dark-first with
// the mirrored light theme, then the queue's own pieces. Served inline: the app is one Worker and has no static assets.
const DARK = `
  --bg: #14171a; --panel: #1b1f23; --panel-2: #23282d; --line: #2f363c; --line-strong: #3d464d;
  --fg: #e7ebe8; --muted: #9ba6a0; --faint: #6c7671;
  --go: #33c27a; --go-ink: #04130b; --go-soft: rgba(51, 194, 122, 0.14);
  --caution: #f0c234; --caution-soft: rgba(240, 194, 52, 0.14);
  --stop: #f0604f; --stop-soft: rgba(240, 96, 79, 0.15);
  --info: #62acef; --info-soft: rgba(98, 172, 239, 0.14);
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.45); --focus: #62acef;
  color-scheme: dark;`;
const LIGHT = `
  --bg: #eef1ef; --panel: #ffffff; --panel-2: #f4f6f5; --line: #d6dcd8; --line-strong: #b9c2bd;
  --fg: #15191c; --muted: #545f59; --faint: #7b8580;
  --go: #168a4b; --go-ink: #ffffff; --go-soft: rgba(22, 138, 75, 0.11);
  --caution: #8a6500; --caution-soft: rgba(196, 146, 0, 0.14);
  --stop: #c33628; --stop-soft: rgba(195, 54, 40, 0.1);
  --info: #1d6db5; --info-soft: rgba(29, 109, 181, 0.1);
  --shadow: 0 12px 32px rgba(20, 30, 25, 0.16); --focus: #1d6db5;
  color-scheme: light;`;

export const STYLES = `
:root {${DARK}
  --radius: 6px; --radius-sm: 4px; --gutter: 16px; --page: 1080px;
  --font-display: "Saira Condensed", "Arial Narrow", "Roboto Condensed", sans-serif;
  --font-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${LIGHT}} }
:root[data-theme="light"] {${LIGHT}}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100dvh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
  font-family: var(--font-body); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased;
}
main { flex: 1 0 auto; }
a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
h1, h2, h3 { margin: 0; font-family: var(--font-display); font-weight: 700; letter-spacing: 0.01em; line-height: 1.1; text-wrap: balance; }
h1 { font-size: 2.1rem; }
h2 { font-size: 1.35rem; }
h3 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0; }
.page { width: 100%; max-width: calc(var(--page) + 2 * var(--gutter)); margin: 0 auto; padding: 24px var(--gutter) 64px; }
.stack { display: grid; gap: 12px; }
.stack-lg { display: grid; gap: 24px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mono, .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.note { font-size: 0.82rem; color: var(--muted); }
.eyebrow { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.pad { padding: 16px 18px; }
.break { overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 16px;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); color: var(--fg);
  font-weight: 600; line-height: 1.2; cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: border-color 0.15s, filter 0.15s;
}
.btn:hover { border-color: var(--muted); text-decoration: none; }
.btn-go { background: var(--go); border-color: var(--go); color: var(--go-ink); }
.btn-go:hover { border-color: var(--go); filter: brightness(1.08); }
.btn-stop { background: transparent; border-color: var(--stop); color: var(--stop); }
.btn-sm { min-height: 32px; padding: 4px 10px; font-size: 0.85rem; }

.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid transparent; border-radius: 3px;
  font-size: 0.75rem; font-weight: 500; line-height: 1.5; white-space: nowrap;
}
.chip-go { background: var(--go-soft); color: var(--go); }
.chip-caution { background: var(--caution-soft); color: var(--caution); }
.chip-stop { background: var(--stop-soft); color: var(--stop); }
.chip-info { background: var(--info-soft); color: var(--info); }
.chip-neutral { background: var(--panel-2); border-color: var(--line); color: var(--muted); }
.flag::before {
  content: ""; flex: none; width: 9px; height: 10px; background: currentColor;
  clip-path: polygon(0 0, 18% 0, 18% 100%, 0 100%, 0 0, 100% 15%, 72% 45%, 100% 75%, 18% 70%, 18% 0);
}

.field { display: grid; gap: 6px; min-width: 0; }
.field > label, .label { font-size: 0.82rem; font-weight: 500; color: var(--muted); }
.input {
  width: 100%; min-width: 0; min-height: 42px; padding: 9px 12px; border: 1px solid var(--line);
  border-radius: var(--radius-sm); background: var(--panel-2); color: var(--fg);
}
.input::placeholder { color: var(--faint); }
.input:focus { border-color: var(--info); outline: none; }
textarea.input { min-height: 84px; resize: vertical; }

.verdict { display: grid; gap: 4px; padding: 10px 12px; border-left: 3px solid transparent; border-radius: var(--radius-sm); overflow-wrap: anywhere; }
.verdict > * { min-width: 0; }
.verdict-go { background: var(--go-soft); border-left-color: var(--go); }
.verdict-caution { background: var(--caution-soft); border-left-color: var(--caution); }
.verdict-stop { background: var(--stop-soft); border-left-color: var(--stop); }
.verdict-info { background: var(--info-soft); border-left-color: var(--info); }
.verdict-neutral { background: var(--panel-2); border-left-color: var(--line-strong); }

/* The header: Heat's flag, the app's name, where it points, and who is signed in. */
.top { border-bottom: 1px solid var(--line); background: var(--panel); }
.top-in {
  max-width: calc(var(--page) + 2 * var(--gutter)); margin: 0 auto; padding: 10px var(--gutter);
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 10px; color: var(--fg); }
.brand:hover { text-decoration: none; }
.brand b { font-family: var(--font-display); font-size: 1.25rem; letter-spacing: 0.04em; text-transform: uppercase; }
.brand span { font-family: var(--font-display); font-size: 1.25rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.nav { display: flex; gap: 4px; flex: 1 1 auto; }
.nav a { padding: 8px 12px; border-radius: var(--radius-sm); color: var(--muted); font-weight: 500; white-space: nowrap; }
.nav a:hover { color: var(--fg); text-decoration: none; background: var(--panel-2); }
.nav a[aria-current="page"] { color: var(--fg); background: var(--panel-2); box-shadow: inset 0 -2px 0 var(--go); }
.who { display: flex; align-items: center; gap: 10px; margin-left: auto; font-size: 0.82rem; color: var(--muted); min-width: 0; }
.who .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.theme {
  display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--line);
  border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer;
}
.theme:hover { color: var(--fg); border-color: var(--muted); }
.theme .moon { display: none; }
:root[data-theme="light"] .theme .sun { display: none; }
:root[data-theme="light"] .theme .moon { display: block; }
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) .theme .sun { display: none; }
  :root:not([data-theme]) .theme .moon { display: block; }
}

.lead { color: var(--muted); max-width: 62ch; }
.flash { padding: 12px 14px; }

/* The queue's tallies. */
.tallies { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tally { padding: 12px 14px; display: grid; gap: 2px; }
.tally .n { font-family: var(--font-mono); font-size: 1.6rem; font-weight: 500; line-height: 1.1; }
.tally.over .n { color: var(--stop); }

/* One item of the queue: what it is, about whom, and how long it has waited against the aim. */
.items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item {
  display: grid; grid-template-columns: minmax(0, 1fr) 140px; gap: 16px; align-items: center; padding: 14px 16px;
  color: var(--fg); transition: border-color 0.15s;
}
.item:hover { border-color: var(--line-strong); text-decoration: none; }
.item-main { display: grid; gap: 4px; min-width: 0; }
.item-title { font-weight: 600; font-size: 1.02rem; overflow-wrap: anywhere; }
.item-why { color: var(--muted); font-size: 0.88rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.age { display: grid; gap: 6px; justify-items: end; text-align: right; }
.age b { font-family: var(--font-mono); font-weight: 500; font-size: 1.05rem; }
.age small { color: var(--muted); font-size: 0.75rem; }
.bar { width: 100%; height: 6px; border-radius: 3px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--go); }
.age.late b { color: var(--caution); }
.age.late .bar i { background: var(--caution); }
.age.over b { color: var(--stop); }
.age.over .bar i { background: var(--stop); }
/* In an item's facts: the figure, a short bar and the aim on one line. */
.age.inline { grid-template-columns: auto minmax(80px, 220px) auto; justify-items: start; align-items: center; gap: 10px; text-align: left; }
.empty { padding: 32px 18px; text-align: center; color: var(--muted); }

/* An item's own page. */
.back { font-size: 0.88rem; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 0; }
.facts dt { color: var(--muted); font-size: 0.85rem; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.coin { display: flex; gap: 12px; align-items: center; }
.coin img { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--line); object-fit: cover; background: var(--panel-2); flex: none; }
.chain { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.chain li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--panel-2); font-size: 0.88rem; }
.quote { padding: 10px 12px; border-left: 3px solid var(--line-strong); background: var(--panel-2); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; }

/* Deciding. */
.decide { display: grid; gap: 14px; }
.choices { display: grid; gap: 8px; border: 0; margin: 0; padding: 0; }
.choice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
.choice:has(input:checked) { border-color: var(--info); background: var(--info-soft); }
.choice input { margin: 3px 0 0; accent-color: var(--info); }
.choice b { font-weight: 600; }
.choice span { grid-column: 2; color: var(--muted); font-size: 0.85rem; }

/* Tables that become cards on a phone. */
.table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.table th { text-align: left; font-weight: 500; color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.table tr:last-child td { border-bottom: 0; }
.table.fixed { table-layout: fixed; }

.foot { border-top: 1px solid var(--line); }
.foot-in { max-width: calc(var(--page) + 2 * var(--gutter)); margin: 0 auto; padding: 14px var(--gutter); font-size: 0.8rem; color: var(--faint); }

@media (max-width: 720px) {
  .tallies { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .who .email { display: none; }
}
@media (max-width: 560px) {
  h1 { font-size: 1.85rem; }
  .page { padding-top: 18px; }
  .top-in { gap: 8px 12px; }
  .nav { order: 3; flex-basis: 100%; overflow-x: auto; margin: 0 calc(-1 * var(--gutter)); padding: 0 var(--gutter); }
  .item { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .age { justify-items: start; text-align: left; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; }
  .age small { grid-column: 1 / -1; margin-top: -4px; }
  .age.inline small { grid-column: auto; margin-top: 0; }
  .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .facts dd { margin-bottom: 8px; }
  .table thead { display: none; }
  .table, .table tbody, .table tr, .table td { display: block; width: 100%; }
  .table tr { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .table tr:last-child { border-bottom: 0; }
  .table td { padding: 2px 0; border: 0; }
  .table td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;
