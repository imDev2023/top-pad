import {
  createSolanaRpcFromTransport,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { blockhashNotFound, rateLimited, sendFresh } from "./send";

const WIRE = "AA==" as Base64EncodedWireTransaction;

type Answer = "taken" | "behind" | "too many" | "program error";
/** An RPC whose sends answer as scripted, the last answer for every send after; `sends` counts them. */
function scripted(...answers: Answer[]) {
  const node = { sends: 0 };
  const refused = (err: unknown) => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed", data: { err, logs: [], accounts: null, unitsConsumed: 0, returnData: null } } });
  const rpc = createSolanaRpcFromTransport((async () => {
    const answer = answers[Math.min(node.sends++, answers.length - 1)]!;
    if (answer === "too many") throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { statusCode: 429, message: "Too Many Requests", headers: new Headers() });
    if (answer === "behind") return refused("BlockhashNotFound");
    if (answer === "program error") return refused({ InstructionError: [2, { Custom: 6005 }] });
    return { jsonrpc: "2.0", id: 1, result: "5".repeat(88) };
  }) as never);
  return { rpc, node };
}
const thrownBy = (sending: Promise<void>) => sending.then(() => null, (e: unknown) => e);

describe("a fresh send", () => {
  it("goes out at once to a node that holds its blockhash", async () => {
    const { rpc, node } = scripted("taken");
    await sendFresh(rpc, WIRE);
    expect(node.sends).toBe(1);
  });

  it("is tried again while the node that takes it is behind its blockhash, and through a 429 between tries", async () => {
    const lagging = scripted("behind", "behind", "taken");
    await sendFresh(lagging.rpc, WIRE, { everyMs: 5 });
    expect(lagging.node.sends).toBe(3);
    const limited = scripted("behind", "too many", "taken");
    await sendFresh(limited.rpc, WIRE, { everyMs: 5 });
    expect(limited.node.sends).toBe(3);
  });

  it("throws the refusal as it came once the wait is over", async () => {
    const { rpc, node } = scripted("behind");
    const e = await thrownBy(sendFresh(rpc, WIRE, { waitMs: 40, everyMs: 5 }));
    expect(blockhashNotFound(e)).toBe(true);
    expect((e as SolanaError).context.__code).toBe(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE);
    expect(node.sends).toBeGreaterThan(2);
  });

  it("throws any other refusal at once: the program's, or a first try's 429", async () => {
    const failing = scripted("program error", "taken");
    const e = await thrownBy(sendFresh(failing.rpc, WIRE, { everyMs: 5 }));
    expect(blockhashNotFound(e)).toBe(false);
    expect((e as SolanaError).context.__code).toBe(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE);
    expect(failing.node.sends).toBe(1);
    const limited = scripted("too many", "taken");
    expect(rateLimited(await thrownBy(sendFresh(limited.rpc, WIRE, { everyMs: 5 })))).toBe(true);
    expect(limited.node.sends).toBe(1);
  });
});
