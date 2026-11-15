import type { CheckedAddress, EnforcedProgram, QuoteList } from "@top-pad/contract";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadEnforcement, loadQuotes } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "How this is enforced",
  description: "Each of Heat's promises, what keeps it, and who could still change it, with the keys and programs on chain.",
};

/** The promises, in the order the page states them, for its index. */
const PROMISES = [
  { id: "fees", title: "The sniper tax and the fee split" },
  { id: "fair-open", title: "Fair Open rules and the 15-minute refund" },
  { id: "creator-lock", title: "Nobody can cancel the Creator lock" },
  { id: "liquidity", title: "Nobody can take the liquidity" },
  { id: "meteora", title: "What Meteora can still do" },
  { id: "bars", title: "Labels, findings and Bars" },
  { id: "listed", title: "Only coins Heat co-signed" },
  { id: "quotes", title: "Coins priced in a stock" },
] as const;

/**
 * "How this is enforced" (spec 9, screen 6): each of Heat's promises, what keeps it, and who could still change it,
 * covering every point spec 9 lists, with the keys and programs each rests on linked to the explorer (each program's
 * upgrade authority as the chain holds it now) and the counts of bars, appeals and overturned findings (spec 6.5).
 */
export default async function Enforced() {
  const [enforcement, quotes] = await Promise.all([loadEnforcement(), loadQuotes()]);
  const chain = enforcement?.chain ?? null;
  const program = (name: EnforcedProgram["name"]) => chain?.programs.find((p) => p.name === name) ?? null;
  const devnet = chain ? chain.cluster !== "mainnet" : true;
  return (
    <div className="page">
      <main className={styles.page}>
        <header className="stack">
          <p className="eyebrow">Heat</p>
          <h1 className={styles.title}>How this is enforced</h1>
          <p className="muted">
            What keeps each of Heat&apos;s promises, and who could still change it. Where a promise rests on a program or a key, it is linked, so you can check
            it on the chain rather than take our word.
          </p>
        </header>

        <nav className={`panel ${styles.index}`} aria-label="The promises">
          <ol>
            {PROMISES.map((p) => (
              <li key={p.id}>
                <a href={`#${p.id}`}>{p.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {!chain && <p className="note">The keys and programs could not be read just now; the promises below stand all the same.</p>}

        <Pledge
          id="fees"
          promise="Every coin pays the same sniper tax and splits its fees the same way, and nobody can edit either after it launches."
          keeps={
            <>
              <p>
                Meteora&apos;s bonding curve config each coin&apos;s pool is created on: the tax falling from 99% to 1.25% over the first minute, then 1.25% a trade;
                Meteora&apos;s fifth of every fee; nothing to the creator from the curve directly; and Heat&apos;s fee program as the partner that collects the rest.
                A config has no instruction that changes it, so it binds every pool made on it, Heat&apos;s and anyone else&apos;s, for good.
              </p>
              <p>
                Heat&apos;s fee program pays the partner share straight on in the same instruction: the first minute&apos;s tax to a Fair Open&apos;s depositors as
                their Tax Share, or to Heat for an Instant launch, never to the creator; after it, half to whoever holds the coin&apos;s creator role and half to
                Heat&apos;s treasury. It never keeps a creator&apos;s balance.
              </p>
              {quotes && chain && <ConfigLinks quotes={quotes} cluster={chain.cluster} />}
            </>
          }
          change={
            <>
              <p>Nobody can edit a config, Heat included; Heat can only make a new one, which binds only coins launched on it later.</p>
              <ProgramAuthority program={program("fee")} devnet={devnet}>
                The fee program&apos;s split is code
              </ProgramAuthority>
              <MeteoraUpgrades />
            </>
          }
          links={chain ? [link("Fee program", program("fee")), link("Treasury", chain.treasury), link("Meteora's bonding curve program", chain.dbc)] : []}
        />

        <Pledge
          id="fair-open"
          promise="In a Fair Open everyone buys at one price at the same moment, within their tier's cap, and nobody but the depositor can move a deposit."
          keeps={
            <p>
              Heat&apos;s Fair Open program holds the deposits in a vault of its own and checks after every deposit, withdrawal and refund that the vault holds
              what it owes. It never opens before the scheduled time; it spends the pot in one buy for every seat; no seat fills past its tier&apos;s cap, and
              Unverified seats together buy at most a quarter of what the pot spends. If the open has not happened 15 minutes after its time, or the minimum raise
              was missed, anyone can mark the launch failed, and each depositor takes back their deposit and both rents themselves.
            </p>
          }
          change={
            <ProgramAuthority program={program("fair_open")} devnet={devnet}>
              These rules are the Fair Open program&apos;s code
            </ProgramAuthority>
          }
          links={chain ? [link("Fair Open program", program("fair_open"))] : []}
        />

        <Pledge
          id="creator-lock"
          promise="Nobody can cancel a Fair Open creator's lock or release it early, Heat included."
          keeps={
            <p>
              Right after the open, the Fair Open program moves every coin the creator&apos;s own deposit bought into a Jupiter Lock escrow it creates with
              cancelling switched off. The coins stay locked for 7 days, then release steadily until day 30. The coin&apos;s page and its Fairness card link the
              escrow.
            </p>
          }
          change={
            <p>
              Nobody can cancel it, shorten it or take the coins back: not the creator, not Heat. The Creator wallet, as its recipient, can name another wallet to
              receive what it releases, and nothing more. Jupiter can upgrade its Lock program.
            </p>
          }
          links={chain ? [link("Jupiter Lock program", chain.jupiterLock)] : []}
        />

        <Pledge
          id="liquidity"
          promise="Nobody can withdraw a coin's liquidity before Graduation, or unlock it after."
          keeps={
            <p>
              Before Graduation the liquidity is the quote in Meteora&apos;s bonding curve, which only trades move; there is no withdrawal for anyone. At
              Graduation the curve migrates into a Meteora DAMM v2 pool and both halves of its liquidity are locked permanently there: the creator&apos;s as their
              own position, Heat&apos;s held by the fee program. A permanently locked position can be claimed for its fees and never withdrawn.
            </p>
          }
          change={<p>Nobody, Heat included. The positions&apos; holders can only claim the fees they earn.</p>}
          links={chain ? [link("Meteora's bonding curve program", chain.dbc), link("Meteora's DAMM v2 program", chain.dammV2)] : []}
        />

        <Pledge
          id="meteora"
          promise="Some powers over a graduated coin's pool stay with Meteora, not Heat, and we say which."
          keeps={
            <p>
              A graduated pool&apos;s fee follows a schedule fixed at Graduation, 1.25% falling to 0.25% as the coin&apos;s market cap reaches 100 times what it
              graduated at, for 10 years. Its dynamic fee starts switched off.
            </p>
          }
          change={
            <>
              <p>
                Meteora&apos;s operators can pause a graduated pool, which stops trading while withdrawals still work, and can change its dynamic fee. They
                cannot change its base fee until the schedule expires.
              </p>
              <MeteoraUpgrades />
            </>
          }
          links={chain ? [link("Meteora's DAMM v2 program", chain.dammV2)] : []}
        />

        <Pledge
          id="bars"
          promise="Copycat and bundling labels are Heat's judgement, always shown with their evidence, and a Bar comes only after a person confirms it."
          keeps={
            <>
              <p>
                Vamp Shield checks each launch&apos;s name, ticker and picture against the coins it protects: an exact copy is refused, with a way to appeal, and
                a near match launches with a &quot;looks like&quot; label naming what it looks like. Bundle Radar labels every coin&apos;s early buyers, with each
                buy, deposit and transfer linked; labels never move a coin. A case opens only when wallets directly linked to the Creator wallet bought 1% of supply
                or more, and a person at Heat confirms it or dismisses it.
              </p>
              <ul className={styles.list}>
                <li>
                  <b>A confirmed creator bundle bars the creator at once.</b> Heat&apos;s launch key co-signs none of their launches, from their Creator record, its
                  Creator wallet or its X account, and their Fair Opens not yet taking deposits are cancelled and refunded.
                </li>
                <li>
                  <b>The finding is private for 72 hours</b>: the creator sees the evidence on their record and can reply. Then their record, the coin&apos;s page
                  and its Fairness card show it.
                </li>
                <li>
                  <b>One appeal within 30 days</b>, decided within 48 hours by someone other than the person who confirmed it; another only with new evidence. An
                  upheld appeal lifts the Bar and takes the finding off every public page. Heat&apos;s audit log keeps every finding and decision, and nobody can
                  edit it.
                </li>
                <li>
                  <b>A Bar never expires and only stops new launches.</b> The creator&apos;s coins keep trading, their Creator Earnings keep flowing, their Creator
                  lock keeps vesting, and they can still trade and deposit in other creators&apos; Fair Opens.
                </li>
              </ul>
              {enforcement ? (
                <dl className={styles.counts} data-testid="enforcement-counts">
                  <div>
                    <dt>Creators barred</dt>
                    <dd className="num" data-testid="count-bars">
                      {enforcement.bars}
                    </dd>
                  </div>
                  <div>
                    <dt>Appeals filed</dt>
                    <dd className="num" data-testid="count-appeals">
                      {enforcement.appeals}
                    </dd>
                  </div>
                  <div>
                    <dt>Findings overturned</dt>
                    <dd className="num" data-testid="count-overturned">
                      {enforcement.overturned}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="note">The counts could not be read just now.</p>
              )}
              <p className="note">Counted once a finding is published or overturned; a finding still in its private 72 hours is in no count.</p>
            </>
          }
          change={
            <p>
              The labels and findings are Heat&apos;s judgement, not a proof: they can be wrong, which is why each one shows its evidence and every Bar can be
              appealed. Nothing on chain enforces a Bar: it is Heat&apos;s launch key declining to co-sign.
            </p>
          }
          links={[]}
        />

        <Pledge
          id="listed"
          promise="These guarantees cover only coins Heat's launch key co-signed, and only those are listed."
          keeps={
            <p>
              Every Heat coin&apos;s creation is co-signed by Heat&apos;s launch key, which registers it in the fee program&apos;s on-chain list of Heat coins; a
              Fair Open&apos;s coin is registered by the Fair Open program as it opens. Heat&apos;s board, search and calendar show only those coins, and Heat
              publishes a signed snapshot of the list every day.
            </p>
          }
          change={
            <p>
              Anyone can create a pool on Heat&apos;s configs without the launch key. Such a pool still pays the sniper tax and the fee split, which live in the
              config, but none of Heat&apos;s other guarantees cover it: no copycat check, no Creator record, no listing. Its page says &quot;Not launched through
              Heat&quot; in red.
            </p>
          }
          links={chain ? [link("Launch key", chain.launchKey), link("Fee program", program("fee"))] : []}
        />

        <section id="quotes" className={`panel ${styles.section}`} aria-labelledby="quotes-title">
          <h2 id="quotes-title" className={styles.heading}>
            Coins priced in a stock
          </h2>
          <p>
            A coin can be priced in SOL or in a tokenized stock, an xStock, that Meteora&apos;s curves take as a quote. Each xStock&apos;s issuer keeps powers over
            every token of it, everywhere it sits, and Heat cannot prevent any of them. The coin&apos;s page, the launch form and the deposit page list the powers
            each quote&apos;s mint holds, read from the chain.
          </p>
          <ul className={styles.list}>
            <li>
              <b>The issuer can pause every transfer.</b> While a quote is paused, its coins&apos; curves and graduated pools take no trades, and a Fair Open in it
              can neither refund, push its coins nor pay its Tax Share out of its vault until the issuer resumes transfers. Heat refuses to schedule a launch in a
              paused quote, and a paused quote fails the open.
            </li>
            <li>
              <b>The issuer can move or burn tokens from any account.</b> A permanent delegate can take the quote out of any wallet, out of a curve&apos;s or a
              graduated pool&apos;s quote vault, and out of a Fair Open&apos;s vault, without anyone&apos;s signature.
            </li>
            <li>
              <b>The issuer can freeze accounts</b>, a wallet&apos;s or a vault&apos;s, which stops it sending or receiving the quote until thawed.
            </li>
            <li>
              <b>The issuer changes how balances read.</b> On a split or a dividend it sets a new Scaled UI Amount multiplier. Heat stores every amount as the
              chain does and shows every price, balance and market cap through the multiplier in force now, so a change rescales a chart as a whole and never
              breaks it.
            </li>
          </ul>
          <p className="muted">
            Heat never takes a quote that charges a transfer fee or whose issuer could add one, whose transfer hook names a program, or whose new accounts start
            frozen. A coin&apos;s Graduation Target is fixed in its quote when it launches, about 8.5 SOL&apos;s worth on devnet at the stock&apos;s price then.
          </p>
        </section>
      </main>
    </div>
  );
}

/** A link to check a promise by, or nothing when the key could not be read. */
const link = (label: string, at: CheckedAddress | null) => (at ? { label, href: at.explorer, address: at.address } : null);

/** One promise: what it says, what keeps it, who could still change it, and where to check it. */
function Pledge({
  id,
  promise,
  keeps,
  change,
  links,
}: {
  id: string;
  promise: string;
  keeps: ReactNode;
  change: ReactNode;
  links: ({ label: string; href: string; address: string } | null)[];
}) {
  const title = PROMISES.find((p) => p.id === id)!.title;
  const shown = links.filter((l) => l !== null);
  return (
    <section id={id} className={`panel ${styles.section}`} aria-labelledby={`${id}-title`} data-testid={`promise-${id}`}>
      <h2 id={`${id}-title`} className={styles.heading}>
        {title}
      </h2>
      <p className={styles.promise}>{promise}</p>
      <div className={styles.part}>
        <h3 className="eyebrow">What keeps it</h3>
        {keeps}
      </div>
      <div className={styles.part}>
        <h3 className="eyebrow">Who could still change it</h3>
        {change}
      </div>
      {shown.length > 0 && (
        <ul className={styles.checks} aria-label="Check it on chain">
          {shown.map((l) => (
            <li key={l.label}>
              <a href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>{" "}
              <span className="mono note">{shortAddress(l.address)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who can upgrade one of Heat's programs, as the chain says now, after the sentence that names what it governs. */
function ProgramAuthority({ program, devnet, children }: { program: EnforcedProgram | null; devnet: boolean; children: ReactNode }) {
  if (program && program.read && program.upgradeable === false) {
    return (
      <p data-testid={`authority-${program.name}`}>
        {children}, and nobody can change it: the program can no longer be upgraded.
      </p>
    );
  }
  const holder = program?.authority ? (
    <a href={program.authority.explorer} target="_blank" rel="noreferrer" className="mono">
      {shortAddress(program.authority.address)}
    </a>
  ) : null;
  return (
    <p data-testid={`authority-${program?.name ?? "unknown"}`}>
      {children}, which its upgrade authority{holder ? <> ({holder})</> : null} could change.{" "}
      {devnet
        ? "On devnet that is a plain key Heat keeps offline; on mainnet it will be a Squads multisig, every upgrade waiting out a 7-day timelock in public, every build verified."
        : "It is a Squads multisig: every upgrade waits out a 7-day timelock in public, and every build is verified."}
      {program && !program.read ? " Who holds it could not be read from the chain just now." : null}
    </p>
  );
}

/** Meteora's own upgrade power, the same for every promise its programs keep. */
function MeteoraUpgrades() {
  return <p>Meteora can upgrade its own programs; Heat cannot.</p>;
}

/** Heat's configs now, a pair a quote: what binds the sniper tax and the fee split of each coin launched on them. */
function ConfigLinks({ quotes, cluster }: { quotes: QuoteList; cluster: string }) {
  const listed = quotes.quotes.filter((q) => q.settings);
  if (!listed.length) return null;
  const explorer = (address: string) => `https://explorer.solana.com/address/${address}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
  return (
    <ul className={styles.checks} aria-label="Heat's configs now">
      {listed.map((q) => (
        <li key={q.mint}>
          {q.symbol}:{" "}
          <span className={styles.nowrap}>
            <a href={explorer(q.settings!.fairOpenConfig)} target="_blank" rel="noreferrer">
              Fair Open config
            </a>{" "}
            <span className="mono note">{shortAddress(q.settings!.fairOpenConfig)}</span>,
          </span>{" "}
          <span className={styles.nowrap}>
            <a href={explorer(q.settings!.instantConfig)} target="_blank" rel="noreferrer">
              Instant config
            </a>{" "}
            <span className="mono note">{shortAddress(q.settings!.instantConfig)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
