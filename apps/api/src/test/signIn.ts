import { signBytes, type KeyPairSigner } from "@solana/kit";
import { WalletSignInMessage } from "@top-pad/contract";
import { ORIGINS } from "./fakes";

type Request = (path: string, init?: RequestInit) => Response | Promise<Response>;

/** Signs `signer` in with its wallet (ADR 0008), as the web app does, and returns the browser's session cookie. */
export async function signInWallet(request: Request, signer: KeyPairSigner): Promise<string> {
  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGINS.web, "content-type": "application/json" } });
  const asked = await post("/auth/wallet/message", { wallet: signer.address });
  if (asked.status !== 200) throw new Error(`the sign-in message was refused: ${await asked.text()}`);
  const { message } = WalletSignInMessage.parse(await asked.json());
  const signature = Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message))).toString("base64");
  const res = await post("/auth/wallet", { wallet: signer.address, message, signature });
  if (res.status !== 200) throw new Error(`the sign-in was refused: ${await res.text()}`);
  return res.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
}
