// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: tests/ui/src/wallet.ts, adapted: Kit in
// place of web3.js (spec 10.1), so the key is a Kit signer and a request is a Kit transaction.
// A Wallet Standard wallet for the browser under test. The page sees an ordinary installed Solana wallet; the key stays in
// Node and signs through an exposed function, so tests decide per request whether the "user" approves or declines.
import { expect, type Locator, type Page } from "@playwright/test";
import {
  getAddressEncoder, getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction,
  type KeyPairSigner, type Transaction,
} from "@solana/kit";

export const TEST_WALLET_NAME = "Test Wallet";

const ICON = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2b45ff"/>` +
    `<path d="M9 12h14v10H9z" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><circle cx="19" cy="17" r="1.8" fill="#fff"/></svg>`,
).toString("base64")}`;

export type TestWallet = {
  signer: KeyPairSigner;
  /** Every transaction the wallet was asked to sign, in order, as the page handed it over. */
  requests: Transaction[];
  /** The next signature request is declined, as a user pressing "Reject" in their wallet. */
  declineNext: () => void;
};

type InitArgs = { name: string; icon: string; address: string; publicKey: number[] };

/** Runs in the page before any app code: registers the wallet with whichever Wallet Standard app shows up. */
function register({ name, icon, address, publicKey }: InitArgs) {
  const chains = ["solana:localnet", "solana:devnet"] as const;
  const account = Object.freeze({
    address,
    publicKey: new Uint8Array(publicKey),
    chains,
    features: ["solana:signTransaction"] as const,
    label: name,
  });
  let accounts: (typeof account)[] = [];
  const listeners = new Set<(p: { accounts: typeof accounts }) => void>();
  const changed = () => listeners.forEach((l) => l({ accounts }));
  const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const sign = (window as unknown as { __testWalletSign: (tx: string) => Promise<string> }).__testWalletSign;

  const wallet = {
    version: "1.0.0",
    name,
    icon,
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = [account];
          changed();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          changed();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, listener: (p: { accounts: typeof accounts }) => void) => {
          if (event !== "change") return () => undefined;
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async ({ transaction }) => ({ signedTransaction: fromB64(await sign(toB64(transaction))) }))),
      },
    },
  };

  const give = (api: { register: (w: unknown) => unknown }) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => give((e as CustomEvent).detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: give }));
}

/**
 * Opens the wallet menu from a "Connect wallet" button and returns the test wallet's entry in it. A click that lands
 * before the page has hydrated does nothing (the button has no handler yet), and on a busy machine hydration can come
 * well after the page looks ready, so it clicks again until the menu is open.
 */
export async function openWalletMenu(page: Page, button: Locator) {
  const item = page.getByRole("menuitem", { name: TEST_WALLET_NAME });
  await expect(async () => {
    if (!(await item.isVisible())) await button.click();
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return item;
}

/** Connects the test wallet from a "Connect wallet" button. */
export async function connectTestWallet(page: Page, button: Locator) {
  await (await openWalletMenu(page, button)).click();
}

/** Installs the wallet into a page; call before the first navigation. */
export async function installTestWallet(page: Page, signer: KeyPairSigner): Promise<TestWallet> {
  let decline = false;
  const wallet: TestWallet = { signer, requests: [], declineNext: () => void (decline = true) };
  const decodeTx = getTransactionDecoder();
  const encodeTx = getTransactionEncoder();
  await page.exposeFunction("__testWalletSign", async (b64: string) => {
    const tx = decodeTx.decode(getBase64Encoder().encode(b64));
    wallet.requests.push(tx);
    if (decline) {
      decline = false;
      throw new Error("User rejected the request.");
    }
    // Fills only this wallet's signature, as a real wallet does: a transaction the server co-signed keeps its other ones.
    const signed = await partiallySignTransaction([signer.keyPair], tx);
    return getBase64Decoder().decode(encodeTx.encode(signed));
  });
  await page.addInitScript(register, {
    name: TEST_WALLET_NAME,
    icon: ICON,
    address: signer.address,
    publicKey: Array.from(getAddressEncoder().encode(signer.address)),
  } satisfies InitArgs);
  return wallet;
}
