// The operator app's pages, rendered on the server: the queue, each item's page with its decision, a case's evidence
// pack, the hubs and the audit log. Plain forms and links, so every action is one request the audit log can name; the
// only script is the theme toggle.
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import type { ProtectedMatch } from "@top-pad/contract";
import type { Operator } from "./env";
import { AIM_HOURS, ageOf, type AdmissionItem, type CaseItem, type LaunchItem, type LaunchKey, type QueueItem, type Refusing } from "./queue";
import { STYLES } from "./styles";

const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Saira+Condensed:wght@600;700&display=swap";

/** The cookie the theme toggle sets, as on the public site; without it the page follows the system. */
export const THEME_COOKIE = "heat_theme";
export type Theme = "light" | "dark";

export type Shell = { nonce: string; operator: Operator | null; cluster: string; theme: Theme | null; current?: "queue" | "hubs" | "audit" };

// Formatting.

export const short = (address: string) => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);
export const when = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const waited = (hours: number) => (hours < 1 ? `${Math.floor(hours * 60)} m` : hours < 72 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} d`);
const explorer = (cluster: string, kind: "address" | "tx", value: string) =>
  `https://explorer.solana.com/${kind}/${value}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** A raw amount in units of `decimals` places, trailing zeros dropped. */
export function units(raw: string | bigint, decimals: number) {
  const v = BigInt(raw);
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${grouped(whole.toString())}${frac ? `.${frac}` : ""}`;
}
/** Encodes a refused launch's key into its page's address. */
export function launchHref(key: LaunchKey) {
  const q = new URLSearchParams({ creator: key.creatorId, ticker: key.ticker, name: key.name });
  if (key.imageSha256) q.set("image", key.imageSha256);
  return `/launch?${q}`;
}

// The shell.

const ThemeButton: FC = () => (
  <button type="button" class="theme" id="theme" aria-label="Switch between the light and dark themes" title="Switch between the light and dark themes">
    <svg class="sun" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="3.6" />
      <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
    </svg>
    <svg class="moon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M16.5 12.3A6.8 6.8 0 0 1 7.7 3.5a6.8 6.8 0 1 0 8.8 8.8Z" />
    </svg>
  </button>
);

// Flips the theme and keeps the choice as a cookie, so the server paints the right one first next time.
const THEME_SCRIPT = `document.getElementById("theme").addEventListener("click", function () {
  var root = document.documentElement;
  var now = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  var next = now === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  document.cookie = "${THEME_COOKIE}=" + next + "; path=/; max-age=31536000; samesite=lax; secure";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", next === "dark" ? "#14171a" : "#eef1ef");
});`;

const Flag: FC = () => (
  <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
    <rect width="32" height="32" rx="7" fill="#14171a" />
    <rect x="8" y="5" width="3" height="22" rx="1" fill="#e7ebe8" />
    <path d="M11 6H25L22 11.5L25 17H11Z" fill="#33c27a" />
  </svg>
);

export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#14171a"/><rect x="8" y="5" width="3" height="22" rx="1" fill="#e7ebe8"/><path d="M11 6H25L22 11.5L25 17H11Z" fill="#33c27a"/></svg>`;

export const Layout: FC<PropsWithChildren<Shell & { title: string }>> = ({ title, nonce, operator, cluster, theme, current, children }) => (
  <html lang="en" data-theme={theme ?? undefined}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="theme-color" content={theme === "light" ? "#eef1ef" : "#14171a"} />
      <title>{`${title} · Heat operator`}</title>
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
      <link rel="stylesheet" href={FONTS} />
      <style nonce={nonce}>{raw(STYLES)}</style>
    </head>
    <body>
      <header class="top">
        <div class="top-in">
          <a class="brand" href="/">
            <Flag />
            <b>Heat</b>
            <span>Operator</span>
          </a>
          <span class={`chip ${cluster === "mainnet" ? "chip-stop" : "chip-info"}`}>{cluster}</span>
          {operator && (
            <nav class="nav" aria-label="Operator">
              <a href="/" aria-current={current === "queue" ? "page" : undefined}>Queue</a>
              <a href="/hubs" aria-current={current === "hubs" ? "page" : undefined}>Hubs</a>
              <a href="/audit" aria-current={current === "audit" ? "page" : undefined}>Audit log</a>
            </nav>
          )}
          <div class="who">
            {operator && <span class="email" title={operator.email}>{operator.email}</span>}
            {operator && <a href="/cdn-cgi/access/logout">Sign out</a>}
            <ThemeButton />
          </div>
        </div>
      </header>
      <main class="page">{children}</main>
      <footer class="foot">
        <div class="foot-in">Heat's operator app. Every action here is written to the audit log, with your email, as you take it.</div>
      </footer>
      <script nonce={nonce}>{raw(THEME_SCRIPT)}</script>
    </body>
  </html>
);

/** What a request without Cloudflare Access's sign-in for this app sees: nothing of the queue. */
export const Denied: FC<Shell> = (shell) => (
  <Layout {...shell} operator={null} title="Sign in">
    <div class="stack" style="max-width: 560px">
      <h1>Sign in through Cloudflare Access</h1>
      <p class="lead">The operator app opens only to an operator Cloudflare Access has signed in for it. This request came without that sign-in, so it shows nothing.</p>
    </div>
  </Layout>
);

export const Missing: FC<Shell & { what: string }> = ({ what, ...shell }) => (
  <Layout {...shell} title="Not here">
    <div class="stack">
      <a class="back" href="/">← Queue</a>
      <h1>Not in the queue</h1>
      <p class="lead">{what}</p>
    </div>
  </Layout>
);

// The queue.

const Age: FC<{ since: Date; now: Date }> = ({ since, now }) => {
  const age = ageOf(since, now);
  return (
    <div class={`age ${age.state}`}>
      <b>{waited(age.hours)}</b>
      <span class="bar" aria-hidden="true">
        <i style={`width: ${Math.round(age.share * 100)}%`} />
      </span>
      <small>{age.state === "over" ? `past the ${AIM_HOURS} h aim` : `of the ${AIM_HOURS} h aim`}</small>
    </div>
  );
};

const kindChip = (item: QueueItem): [string, string] => {
  if (item.kind === "launch") return item.appeals.length > 0 ? ["chip-info", "Appeal"] : ["chip-stop", "Refused launch"];
  if (item.kind === "admission") return item.reviews.some((r) => r.kind === "refused") ? ["chip-stop", "Admission refused"] : ["chip-caution", "Admission merged"];
  return ["chip-stop", "Bundling case"];
};

const fairOpenName = (item: AdmissionItem) => {
  const f = item.fairOpen;
  if (!f) return `Fair Open ${short(item.launch)}`;
  if (f.opened && f.ticker) return `$${f.ticker}'s Fair Open`;
  return f.teaser ? `the Fair Open "${f.teaser}"` : `Fair Open ${short(item.launch)}`;
};

function itemLine(item: QueueItem): { href: string; title: string; who: string; why: string } {
  if (item.kind === "launch") {
    const fields = item.refusing.map((r) => r.field).join(", ") || "its text";
    return {
      href: launchHref(item.key),
      title: `$${item.key.ticker} · ${item.key.name}`,
      who: `@${item.handle}`,
      why:
        item.appeals.length > 0
          ? `Appealed: "${item.appeals[0]!.message}"`
          : `Refused for its ${fields}${item.refusing[0] ? `, as ${item.refusing[0].coin.ticker.startsWith("$") ? "" : "$"}${item.refusing[0].coin.ticker}'s` : ""}; ${item.attempts} ${item.attempts === 1 ? "try" : "tries"}.`,
    };
  }
  if (item.kind === "admission") {
    return {
      href: `/admissions/${item.launch}/${item.wallet}`,
      title: `${short(item.wallet)} in ${fairOpenName(item)}`,
      who: item.fairOpen?.creatorHandle ? `creator @${item.fairOpen.creatorHandle}` : "creator unknown here",
      why: item.reviews[0]!.reason,
    };
  }
  return {
    href: `/cases/${item.mint}`,
    title: item.coin ? `$${item.coin.ticker} · ${item.coin.name}` : `Coin ${short(item.mint)}`,
    who: item.handle ? `creator @${item.handle}` : `Creator wallet ${short(item.creatorWallet)}`,
    why: `${item.linkedWallets} ${item.linkedWallets === 1 ? "wallet" : "wallets"} linked to the Creator wallet bought ${item.share ?? "1% or more"} of supply.`,
  };
}

export const QueuePage: FC<Shell & { items: QueueItem[]; now: Date; flash: Child }> = ({ items, now, flash, ...shell }) => {
  const count = (k: QueueItem["kind"]) => items.filter((i) => i.kind === k).length;
  const over = items.filter((i) => ageOf(i.since, now).state === "over").length;
  return (
    <Layout {...shell} title="Queue" current="queue">
      <div class="stack-lg">
        <div class="stack">
          <h1>Queue</h1>
          <p class="lead">Refused launches and their appeals, refused or merged admissions, and bundling cases: everything waiting on an operator, oldest first. The aim is an answer within {AIM_HOURS} hours.</p>
        </div>
        {flash}
        <div class="tallies">
          <div class="panel tally">
            <span class="eyebrow">Launches</span>
            <span class="n" data-testid="tally-launch">{count("launch")}</span>
          </div>
          <div class="panel tally">
            <span class="eyebrow">Admissions</span>
            <span class="n" data-testid="tally-admission">{count("admission")}</span>
          </div>
          <div class="panel tally">
            <span class="eyebrow">Bundling cases</span>
            <span class="n" data-testid="tally-case">{count("case")}</span>
          </div>
          <div class={`panel tally${over > 0 ? " over" : ""}`}>
            <span class="eyebrow">Past {AIM_HOURS} h</span>
            <span class="n" data-testid="tally-over">{over}</span>
          </div>
        </div>
        {items.length === 0 ? (
          <div class="panel empty">Nothing is waiting on an operator.</div>
        ) : (
          <ul class="items">
            {items.map((item) => {
              const line = itemLine(item);
              const [tone, label] = kindChip(item);
              return (
                <li>
                  <a class="panel item" href={line.href} data-kind={item.kind}>
                    <div class="item-main">
                      <div class="row">
                        <span class={`chip flag ${tone}`}>{label}</span>
                        <span class="note">{line.who}</span>
                      </div>
                      <span class="item-title">{line.title}</span>
                      <span class="item-why">{line.why}</span>
                    </div>
                    <Age since={item.since} now={now} />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Layout>
  );
};

export const Flash: FC<{ tone: "go" | "stop" | "info"; children: Child }> = ({ tone, children }) => (
  <div class={`verdict verdict-${tone} flash`} role={tone === "stop" ? "alert" : "status"}>
    {children}
  </div>
);

// A refused launch.

const sourceName: Record<ProtectedMatch["source"], string> = {
  jupiter_verified: "Verified on Jupiter",
  organic: "Real trading on Solana",
  trending: "Trending on Jupiter",
  coingecko_top: "CoinGecko top 1,000",
  heat: "A Heat coin",
};

const Matched: FC<{ r: Refusing }> = ({ r }) => (
  <div class="verdict verdict-stop">
    <div class="coin">
      {r.coin.imageUrl && <img src={r.coin.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />}
      <div class="stack" style="gap: 2px">
        <b>
          {r.field[0]!.toUpperCase() + r.field.slice(1)} refused as {r.coin.ticker.startsWith("$") ? "" : "$"}
          {r.coin.ticker} ({r.coin.name})
        </b>
        <span class="note">
          {sourceName[r.coin.source]} · <a href={r.coin.url} rel="noreferrer" target="_blank">see the protected coin</a>
        </span>
      </div>
    </div>
    {r.reason && <span>{r.reason}</span>}
  </div>
);

const Choice: FC<{ name: string; value: string; title: string; checked?: boolean; children: Child }> = ({ name, value, title, checked, children }) => (
  <label class="choice">
    <input type="radio" name={name} value={value} required checked={checked} />
    <b>{title}</b>
    <span>{children}</span>
  </label>
);

const NoteField: FC<{ placeholder: string }> = ({ placeholder }) => (
  <div class="field">
    <label for="note">Why (kept in the audit log)</label>
    <textarea class="input" id="note" name="note" required maxlength={1000} placeholder={placeholder} />
  </div>
);

export const LaunchPage: FC<Shell & { item: LaunchItem; now: Date; error: string | null }> = ({ item, now, error, ...shell }) => (
  <Layout {...shell} title={`$${item.key.ticker}`} current="queue">
    <div class="stack-lg">
      <div class="stack">
        <a class="back" href="/">← Queue</a>
        <span class="eyebrow">{item.appeals.length > 0 ? "Appeal against a refused launch" : "Refused launch"}</span>
        <h1 class="break">
          ${item.key.ticker} · {item.key.name}
        </h1>
      </div>
      {error && <Flash tone="stop">{error}</Flash>}
      <div class="panel pad stack">
        <dl class="facts">
          <dt>Creator</dt>
          <dd>@{item.handle}</dd>
          <dt>Waiting</dt>
          <dd>
            <Age since={item.since} now={now} />
          </dd>
          <dt>Refused</dt>
          <dd>{item.attempts > 0 ? `${item.attempts} ${item.attempts === 1 ? "time" : "times"}, last ${when(item.lastRefusedAt!)}` : "Appealed before any launch was tried"}</dd>
          <dt>Image</dt>
          <dd class="mono break">{item.key.imageSha256 ?? "not checked: the text was refused first"}</dd>
        </dl>
      </div>
      <section class="stack">
        <h3>What Vamp Shield refused</h3>
        {item.refusing.length === 0 ? <p class="muted">No protected coin is named: the refusal was of the text's own form, which no review can clear.</p> : item.refusing.map((r) => <Matched r={r} />)}
      </section>
      {item.appeals.length > 0 && (
        <section class="stack">
          <h3>{item.appeals.length === 1 ? "The creator's appeal" : `The creator's ${item.appeals.length} appeals`}</h3>
          {item.appeals.map((a) => (
            <div class="panel pad stack">
              <span class="note">
                {when(a.createdAt)}
                {a.original && (
                  <>
                    {" "}
                    · names the original <a href={explorer(shell.cluster, "address", a.original)} class="mono" rel="noreferrer" target="_blank">{short(a.original)}</a>
                  </>
                )}
              </span>
              <p class="quote">{a.message}</p>
            </div>
          ))}
        </section>
      )}
      <form method="post" action={launchHref(item.key)} class="panel pad decide">
        <h2>Decide</h2>
        <fieldset class="choices">
          <legend class="visually-hidden">Decision</legend>
          <Choice name="decision" value="cleared" title="Clear this launch">
            @{item.handle} may launch {item.refusing.length > 0 ? `this ${item.refusing.map((r) => r.field).join(" and ")}` : "it"}: their own checks pass it with no label. Anyone else is still refused.
            {item.appeals.length > 0 && " The appeal is upheld."}
          </Choice>
          <Choice name="decision" value="kept" title="Keep it refused">
            The refusal stands. {item.appeals.length > 0 ? "The appeal is denied." : "It leaves the queue until the creator is refused again."}
          </Choice>
        </fieldset>
        <NoteField placeholder="The original team relaunching, shown by the mint authority; or: a copy of $BONK's picture." />
        <div class="row">
          <button class="btn btn-go" type="submit">
            Record the decision
          </button>
        </div>
      </form>
    </div>
  </Layout>
);

// An admission.

type Step = { wallet: string; funder: string; signature: string; amount: string; at: string | null; passThrough: boolean };
const stepsOf = (evidence: unknown, which: string): Step[] => {
  const trace = (evidence as Record<string, { chain?: Step[] }> | null)?.[which];
  return Array.isArray(trace?.chain) ? trace.chain : [];
};

const Chain: FC<{ cluster: string; title: string; steps: Step[] }> = ({ cluster, title, steps }) => (
  <div class="stack" style="gap: 6px">
    <span class="label">{title}</span>
    {steps.length === 0 ? (
      <p class="note">No wallet funded it with a plain transfer that Heat follows.</p>
    ) : (
      <ol class="chain">
        {steps.map((s) => (
          <li>
            <span class="break">
              <a class="mono" href={explorer(cluster, "address", s.funder)} rel="noreferrer" target="_blank">
                {short(s.funder)}
              </a>{" "}
              funded{" "}
              <a class="mono" href={explorer(cluster, "address", s.wallet)} rel="noreferrer" target="_blank">
                {short(s.wallet)}
              </a>
              {s.passThrough && <span class="chip chip-neutral" style="margin-left: 6px">pass-through</span>}
            </span>
            <a class="num" href={explorer(cluster, "tx", s.signature)} rel="noreferrer" target="_blank">
              {units(s.amount, 9)} SOL
            </a>
            {s.at && <span class="note" style="grid-column: 1 / -1">{when(new Date(s.at))}</span>}
          </li>
        ))}
      </ol>
    )}
  </div>
);

export const AdmissionPage: FC<Shell & { item: AdmissionItem; now: Date; error: string | null }> = ({ item, now, error, ...shell }) => {
  const refused = item.reviews.some((r) => r.kind === "refused");
  const f = item.fairOpen;
  return (
    <Layout {...shell} title={`Admission ${short(item.wallet)}`} current="queue">
      <div class="stack-lg">
        <div class="stack">
          <a class="back" href="/">← Queue</a>
          <span class="eyebrow">{refused ? "Refused admission" : "Merged admission"}</span>
          <h1 class="break">
            {short(item.wallet)} in {fairOpenName(item)}
          </h1>
        </div>
        {error && <Flash tone="stop">{error}</Flash>}
        <div class="panel pad">
          <dl class="facts">
            <dt>Wallet</dt>
            <dd>
              <a class="mono break" href={explorer(shell.cluster, "address", item.wallet)} rel="noreferrer" target="_blank">
                {item.wallet}
              </a>
            </dd>
            <dt>Fair Open</dt>
            <dd>
              <a class="mono break" href={explorer(shell.cluster, "address", item.launch)} rel="noreferrer" target="_blank">
                {item.launch}
              </a>
              {f && (
                <div class="note">
                  {f.creatorHandle ? `by @${f.creatorHandle}` : "creator unknown here"}
                  {f.opensAt && `, ${f.opened ? "opened" : "opens"} ${when(f.opensAt)}`}
                  {!f.opened && ": its coin stays sealed until its open"}
                </div>
              )}
            </dd>
            <dt>Waiting</dt>
            <dd>
              <Age since={item.since} now={now} />
            </dd>
          </dl>
        </div>
        {item.reviews.map((r) => (
          <section class="panel pad stack">
            <div class="row">
              <span class={`chip flag ${r.kind === "refused" ? "chip-stop" : "chip-caution"}`}>{r.kind === "refused" ? "Refused" : "Merged"}</span>
              <span class="note">
                {when(r.createdAt)} · counted as <span class="mono">{r.cluster.replace(/^wallet:(.{4}).*(.{4})$/, "wallet:$1…$2")}</span>
              </span>
            </div>
            <p class="quote">{r.reason}</p>
            <Chain cluster={shell.cluster} title="Where this wallet's SOL came from" steps={stepsOf(r.evidence, "wallet")} />
            {stepsOf(r.evidence, "creator").length > 0 && <Chain cluster={shell.cluster} title="Where the Creator wallet's SOL came from" steps={stepsOf(r.evidence, "creator")} />}
            {stepsOf(r.evidence, "holder").length > 0 && <Chain cluster={shell.cluster} title="Where the seat holder's SOL came from" steps={stepsOf(r.evidence, "holder")} />}
          </section>
        ))}
        <form method="post" action={`/admissions/${item.launch}/${item.wallet}`} class="panel pad decide">
          <h2>Decide</h2>
          <fieldset class="choices">
            <legend class="visually-hidden">Decision</legend>
            <Choice name="decision" value="cleared" title="Clear this wallet for future Fair Opens">
              In every Fair Open whose deposits open from now on, nothing ties it to a creator or merges it: it holds a seat of its own. This Fair Open keeps its {refused ? "refusal" : "merge"}.
            </Choice>
            {item.root && (
              <Choice name="decision" value="hub" title={`Name ${short(item.root)} a hub`}>
                Its SOL came from {short(item.root)}. A hub, as an exchange's hot wallet or a faucet is, ties nobody together: from now on no wallet is merged or refused through it, and every open review traced to it is answered.
              </Choice>
            )}
            <Choice name="decision" value="kept" title={`Keep the ${refused ? "refusal" : "merge"}`}>
              The linkage pipeline was right. It leaves the queue.
            </Choice>
          </fieldset>
          {item.root && (
            <div class="field">
              <label for="label">The hub's name, if naming it a hub</label>
              <input class="input" id="label" name="label" maxlength={120} placeholder="Binance hot wallet 3" />
            </div>
          )}
          <NoteField placeholder="A friend who funded them once, not one person; or: five wallets from one faucet drip." />
          <div class="row">
            <button class="btn btn-go" type="submit">
              Record the decision
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
};

// A bundling case.

export type CaseView = { item: CaseItem; quoteMint: string | null; now: Date };

export const CasePage: FC<Shell & CaseView & { error: string | null }> = ({ item, now, error, ...shell }) => (
  <Layout {...shell} title={item.coin ? `$${item.coin.ticker} case` : "Bundling case"} current="queue">
    <div class="stack-lg">
      <div class="stack">
        <a class="back" href="/">← Queue</a>
        <span class="eyebrow">Bundling case</span>
        <h1 class="break">{item.coin ? `$${item.coin.ticker} · ${item.coin.name}` : `Coin ${short(item.mint)}`}</h1>
      </div>
      {error && <Flash tone="stop">{error}</Flash>}
      <div class="panel pad">
        <dl class="facts">
          <dt>Coin</dt>
          <dd>
            <a class="mono break" href={explorer(shell.cluster, "address", item.mint)} rel="noreferrer" target="_blank">
              {item.mint}
            </a>
          </dd>
          <dt>Creator</dt>
          <dd>
            {item.handle ? `@${item.handle}, ` : ""}
            <a class="mono" href={explorer(shell.cluster, "address", item.creatorWallet)} rel="noreferrer" target="_blank">
              {short(item.creatorWallet)}
            </a>
          </dd>
          <dt>Linked buying</dt>
          <dd>
            {item.linkedWallets} {item.linkedWallets === 1 ? "wallet" : "wallets"} directly linked to the Creator wallet bought {item.share ?? "1% or more"} of supply across the pot and the first hour.
          </dd>
          <dt>Opened</dt>
          <dd>{when(item.since)}</dd>
          <dt>Waiting</dt>
          <dd>
            <Age since={item.since} now={now} />
          </dd>
        </dl>
      </div>
      <form method="post" action={`/cases/${item.mint}/evidence`} class="panel pad decide">
        <h2>The evidence pack</h2>
        <p class="muted">The transactions, Jito bundle ids and transfers behind each link, as Bundle Radar stored them. Opening it is written to the audit log. Confirming the case and hearing its appeal come with the Bars.</p>
        <div class="row">
          <button class="btn btn-go" type="submit">
            Open the evidence pack
          </button>
        </div>
      </form>
    </div>
  </Layout>
);

type Pack = {
  rule?: string;
  reviewedAt?: string;
  openedAt?: string;
  creation?: { signature: string; slot: number; blockIndex: number | null; explorer?: string };
  floor?: { supply: string; floor: string; linkedCoins: string; share: string };
  wallets?: {
    wallet: string;
    labels: string[];
    counted: string;
    deposits?: { signature: string; at: string; amount: string; creatorSigned: boolean }[];
    buys?: { signature: string; at: string; baseAmount: string; quoteAmount: string; position: number | null; firstHour: boolean }[];
    transfers?: { signature: string; at: string; direction: "from_creator" | "to_creator"; asset: string; amount: string }[];
  }[];
};

// Bundle Radar's labels (`RadarLabel` in @top-pad/indexer), in the words the coin page uses.
const LABELS: Record<string, string> = {
  creator_funded: "Direct transfers with the Creator wallet",
  creator_signed: "The Creator wallet signed or paid",
  after_creation: "Bought right after the creation",
  jito_bundle: "In the creation's Jito bundle",
  same_slot: "Same slot as the creation",
};

const WSOL = "So11111111111111111111111111111111111111112";

export const EvidencePage: FC<Shell & CaseView & { pack: Pack; source: "r2" | "postgres"; matches: boolean }> = ({ item, quoteMint, pack, source, matches, ...shell }) => {
  const supply = pack.floor ? BigInt(pack.floor.supply) : null;
  const shareOf = (coins: string) => (supply && supply > 0n ? `${(Number((BigInt(coins) * 1_000_000n) / supply) / 10_000).toFixed(2)}%` : "");
  const quote = (raw: string) => (!quoteMint || quoteMint === WSOL ? `${units(raw, 9)} SOL` : `${grouped(raw)} raw units`);
  const tx = (signature: string, text: Child) => (
    <a href={explorer(shell.cluster, "tx", signature)} rel="noreferrer" target="_blank">
      {text}
    </a>
  );
  return (
    <Layout {...shell} title="Evidence pack" current="queue">
      <div class="stack-lg">
        <div class="stack">
          <a class="back" href={`/cases/${item.mint}`}>
            ← The case
          </a>
          <span class="eyebrow">Evidence pack</span>
          <h1 class="break">{item.coin ? `$${item.coin.ticker} · ${item.coin.name}` : `Coin ${short(item.mint)}`}</h1>
        </div>
        <Flash tone={source === "r2" && matches ? "info" : "stop"}>
          {source === "r2"
            ? matches
              ? `Read from R2 (${item.evidenceKey}), the same as the case's own copy in Postgres.`
              : `Read from R2 (${item.evidenceKey}), and it differs from the case's own copy in Postgres: compare both before acting.`
            : `R2 holds no pack at ${item.evidenceKey}: this is the case's own copy in Postgres.`}
        </Flash>
        <div class="panel pad stack">
          {pack.rule && <p>{pack.rule}</p>}
          <dl class="facts">
            {pack.floor && (
              <>
                <dt>Bought by linked wallets</dt>
                <dd class="num">
                  {units(pack.floor.linkedCoins, 6)} coins, {pack.floor.share} of supply (the floor is {units(pack.floor.floor, 6)})
                </dd>
              </>
            )}
            {pack.creation && (
              <>
                <dt>Creation</dt>
                <dd>
                  {tx(pack.creation.signature, <span class="mono">{short(pack.creation.signature)}</span>)} in slot <span class="num">{pack.creation.slot}</span>
                  {pack.creation.blockIndex !== null && `, position ${pack.creation.blockIndex} in its block`}
                </dd>
              </>
            )}
            {pack.openedAt && (
              <>
                <dt>Trading opened</dt>
                <dd>{when(new Date(pack.openedAt))}</dd>
              </>
            )}
            {pack.reviewedAt && (
              <>
                <dt>Reviewed</dt>
                <dd>{when(new Date(pack.reviewedAt))}</dd>
              </>
            )}
          </dl>
        </div>
        <section class="stack">
          <h3>Linked wallets</h3>
          {(pack.wallets ?? []).map((w) => (
            <div class="panel pad stack">
              <div class="row" style="justify-content: space-between">
                <a class="mono break" href={explorer(shell.cluster, "address", w.wallet)} rel="noreferrer" target="_blank">
                  {w.wallet}
                </a>
                <span class="num">counted {shareOf(w.counted)}</span>
              </div>
              <div class="row">
                {w.labels.map((l) => (
                  <span class="chip chip-stop">{LABELS[l] ?? l}</span>
                ))}
              </div>
              <table class="table">
                <thead>
                  <tr>
                    <th>What</th>
                    <th>When</th>
                    <th>Amount</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {(w.transfers ?? []).map((t) => (
                    <tr>
                      <td data-label="What">{t.direction === "from_creator" ? "From the Creator wallet" : "To the Creator wallet"}</td>
                      <td data-label="When">{when(new Date(t.at))}</td>
                      <td data-label="Amount" class="num">
                        {t.asset === "SOL" ? `${units(t.amount, 9)} SOL` : `${grouped(t.amount)} raw ${short(t.asset)}`}
                      </td>
                      <td data-label="Transaction">{tx(t.signature, <span class="mono">{short(t.signature)}</span>)}</td>
                    </tr>
                  ))}
                  {(w.deposits ?? []).map((d) => (
                    <tr>
                      <td data-label="What">Deposit into the pot{d.creatorSigned ? ", the Creator wallet signing" : ""}</td>
                      <td data-label="When">{when(new Date(d.at))}</td>
                      <td data-label="Amount" class="num">
                        {quote(d.amount)}
                      </td>
                      <td data-label="Transaction">{tx(d.signature, <span class="mono">{short(d.signature)}</span>)}</td>
                    </tr>
                  ))}
                  {(w.buys ?? []).map((b) => (
                    <tr>
                      <td data-label="What">
                        Buy{b.position !== null ? `, position ${b.position} after the creation` : ""}
                        {b.firstHour ? "" : ", after the first hour"}
                      </td>
                      <td data-label="When">{when(new Date(b.at))}</td>
                      <td data-label="Amount" class="num">
                        {units(b.baseAmount, 6)} coins for {quote(b.quoteAmount)}
                      </td>
                      <td data-label="Transaction">{tx(b.signature, <span class="mono">{short(b.signature)}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>
    </Layout>
  );
};

// Hubs.

export type HubRow = { address: string; label: string; addedBy: string | null; createdAt: Date };

export const HubsPage: FC<Shell & { hubs: HubRow[]; flash: Child }> = ({ hubs, flash, ...shell }) => (
  <Layout {...shell} title="Hubs" current="hubs">
    <div class="stack-lg">
      <div class="stack">
        <h1>Hubs</h1>
        <p class="lead">Addresses the linkage pipeline never ties anyone through: exchanges, bridges, routers and faucets. Heat's own keys, devnet's bank and any wallet with 1,000 signatures are hubs already.</p>
      </div>
      {flash}
      <form method="post" action="/hubs" class="panel pad decide">
        <h2>Name a hub</h2>
        <div class="field">
          <label for="address">Address</label>
          <input class="input mono" id="address" name="address" required maxlength={44} placeholder="5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" />
        </div>
        <div class="field">
          <label for="hub-label">What it is</label>
          <input class="input" id="hub-label" name="label" required maxlength={120} placeholder="Binance hot wallet 3" />
        </div>
        <div class="row">
          <button class="btn btn-go" type="submit">
            Name it a hub
          </button>
        </div>
      </form>
      <section class="stack">
        <h3>{hubs.length === 1 ? "1 hub" : `${hubs.length} hubs`}</h3>
        {hubs.length === 0 ? (
          <div class="panel empty">No operator has named a hub yet.</div>
        ) : (
          <div class="panel pad">
            <table class="table">
              <thead>
                <tr>
                  <th>Hub</th>
                  <th>Named</th>
                  <th>Take it off</th>
                </tr>
              </thead>
              <tbody>
                {hubs.map((h) => (
                  <tr>
                    <td data-label="Hub">
                      <b>{h.label}</b>
                      <div>
                        <a class="mono break" href={explorer(shell.cluster, "address", h.address)} rel="noreferrer" target="_blank">
                          {h.address}
                        </a>
                      </div>
                    </td>
                    <td data-label="Named">
                      {when(h.createdAt)}
                      {h.addedBy && <div class="note">{h.addedBy}</div>}
                    </td>
                    <td data-label="Take it off">
                      <form method="post" action={`/hubs/${h.address}/remove`} class="row">
                        <input class="input" name="note" required maxlength={1000} placeholder="Why" aria-label={`Why ${h.label} is no hub`} style="flex: 1 1 140px; min-height: 32px; padding: 4px 10px" />
                        <button class="btn btn-sm btn-stop" type="submit">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  </Layout>
);

// The audit log.

export type AuditRow = { id: number; at: Date; operator: string; action: string; subject: string; detail: unknown };
export type RunRow = { id: string; status: string; startedAt: Date; summary: unknown; error: string | null };

const ACTION_NAMES: Record<string, string> = {
  launch_cleared: "Cleared a launch",
  launch_kept: "Kept a launch refused",
  wallet_cleared: "Cleared a wallet",
  admission_kept: "Kept an admission",
  hub_added: "Named a hub",
  hub_removed: "Removed a hub",
  evidence_opened: "Opened an evidence pack",
  audit_exported: "Exported the audit log",
};

const detailLine = (detail: unknown) => {
  const d = (detail ?? {}) as Record<string, unknown>;
  const parts = [d.ticker && `$${d.ticker}`, d.label && `"${d.label}"`, d.note && `"${d.note}"`].filter(Boolean);
  return parts.join(" · ");
};

export const AuditPage: FC<Shell & { rows: AuditRow[]; runs: RunRow[]; files: { key: string; size: number; rows: string | null }[]; flash: Child }> = ({ rows, runs, files, flash, ...shell }) => (
  <Layout {...shell} title="Audit log" current="audit">
    <div class="stack-lg">
      <div class="stack">
        <h1>Audit log</h1>
        <p class="lead">Every operator action, as it was taken. Nobody can change or delete a row, the operator app's own database role included, and each day's rows are exported to R2 just after the day ends.</p>
      </div>
      {flash}
      <section class="stack">
        <h3>The latest {rows.length === 1 ? "action" : `${rows.length} actions`}</h3>
        {rows.length === 0 ? (
          <div class="panel empty">No operator has acted yet.</div>
        ) : (
          <div class="panel pad">
            <table class="table" data-testid="audit-rows">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td data-label="When" class="num">
                      {when(r.at)}
                    </td>
                    <td data-label="Who" class="break">
                      {r.operator}
                    </td>
                    <td data-label="What">
                      <b>{ACTION_NAMES[r.action] ?? r.action}</b>
                      {detailLine(r.detail) && <div class="note break">{detailLine(r.detail)}</div>}
                    </td>
                    <td data-label="On" class="mono break">
                      {r.subject.replace(/([1-9A-HJ-NP-Za-km-z]{32,44})/g, (a) => short(a))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section class="panel pad stack">
        <h2>The daily export</h2>
        <p class="muted">Each whole day goes to R2 at operator-audit/&lt;day&gt;.jsonl, one row a line, at 00:15 UTC the next day. A day already written is never written again.</p>
        <form method="post" action="/audit/export" class="row">
          <button class="btn" type="submit">
            Export every finished day now
          </button>
        </form>
        {runs.length > 0 && (
          <table class="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Outcome</th>
                <th>Days written</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const s = r.summary as { exported?: { day: string; rows: number }[] } | null;
                return (
                  <tr>
                    <td data-label="Run" class="num">
                      {when(r.startedAt)}
                    </td>
                    <td data-label="Outcome">
                      <span class={`chip ${r.status === "succeeded" ? "chip-go" : r.status === "failed" ? "chip-stop" : "chip-neutral"}`}>{r.status}</span>
                      {r.error && <div class="note break">{r.error}</div>}
                    </td>
                    <td data-label="Days written" class="num">
                      {s?.exported?.length ? s.exported.map((e) => `${e.day} (${e.rows})`).join(", ") : "none due"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {files.length > 0 && (
          <div class="stack" style="gap: 4px">
            <span class="label">In R2</span>
            <ul class="chain">
              {files.map((f) => (
                <li>
                  <span class="mono break">{f.key}</span>
                  <span class="num">{f.rows === null ? `${f.size} B` : `${f.rows} ${f.rows === "1" ? "row" : "rows"}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  </Layout>
);
