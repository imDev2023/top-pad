import { getBase58Encoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockPositions, DBC_POOL_AUTHORITY, holderCount, logsSubscribeRequest, parseLogsMessage, webSocketUrlOf } from "./live";

afterEach(() => vi.unstubAllGlobals());

/** A stand-in RPC endpoint answering each method with the next of its answers. */
function rpc(answers: Record<string, unknown[]>) {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    calls.push({ method, params });
    const answer = answers[method]?.shift();
    if (answer instanceof Error) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32004, message: answer.message } });
    return Response.json({ jsonrpc: "2.0", id: 1, result: answer ?? null });
  });
  return calls;
}

describe("block positions", () => {
  it("give a transaction's place in its block, fetching each slot once", async () => {
    const calls = rpc({ getBlock: [{ signatures: ["a", "b", "c"] }] });
    const blockIndexOf = blockPositions("https://rpc.example");
    expect(await blockIndexOf(9, "c")).toBe(2);
    expect(await blockIndexOf(9, "a")).toBe(0);
    expect(calls.filter((c) => c.method === "getBlock")).toHaveLength(1);
    expect(calls[0]!.params).toEqual([9, { transactionDetails: "signatures", rewards: false, commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    await expect(blockIndexOf(9, "z")).rejects.toThrow("not in block 9");
  });

  it("wait for a block the node does not serve yet", async () => {
    rpc({ getBlock: [new Error("Block not available for slot 9"), null, { signatures: ["a"] }] });
    expect(await blockPositions("https://rpc.example")(9, "a")).toBe(0);
  });

  it("give up on a block never served, and ask again next time", async () => {
    const calls = rpc({ getBlock: [null, null, { signatures: ["a"] }] });
    const blockIndexOf = blockPositions("https://rpc.example", { waitMs: 0 });
    await expect(blockIndexOf(9, "a")).rejects.toThrow("not served");
    await expect(blockIndexOf(9, "a")).rejects.toThrow("not served");
    expect(await blockIndexOf(9, "a")).toBe(0);
    expect(calls).toHaveLength(3);
  });
});

describe("holders", () => {
  /** A token account's slice the count asks for: its owner, then its amount. */
  const account = (owner: number[], amount: bigint) => {
    const data = new Uint8Array(40);
    data.set(owner);
    new DataView(data.buffer).setBigUint64(32, amount, true);
    return { account: { data: [btoa(String.fromCharCode(...data)), "base64"] } };
  };
  it("count the owners with a balance, not the pool", async () => {
    const alice = Array(32).fill(1);
    const bob = Array(32).fill(2);
    const authority = Array.from(getBase58Encoder().encode(DBC_POOL_AUTHORITY));
    const calls = rpc({
      getProgramAccounts: [[account(authority, 999n), account(alice, 5n), account(alice, 7n), account(bob, 0n)]],
    });
    expect(await holderCount("https://rpc.example", "Mint111")).toBe(1);
    expect(calls[0]!.params[1]).toMatchObject({ filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: "Mint111" } }] });
  });
});

describe("the logs subscription", () => {
  it("runs over the RPC's own URL as a WebSocket", () => {
    expect(webSocketUrlOf("https://devnet.helius-rpc.com/?api-key=k")).toBe("wss://devnet.helius-rpc.com/?api-key=k");
    expect(JSON.parse(logsSubscribeRequest(3, "Acc"))).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "logsSubscribe",
      params: [{ mentions: ["Acc"] }, { commitment: "confirmed" }],
    });
  });

  it("tells a subscription's answer from a transaction it reports", () => {
    expect(parseLogsMessage('{"id":1,"jsonrpc":"2.0","result":7}')).toEqual({ kind: "subscribed", id: 1, subscription: 7 });
    expect(parseLogsMessage('{"id":2,"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"}}')).toEqual({ kind: "refused", id: 2, error: "Invalid params" });
    const notification = {
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { subscription: 7, result: { context: { slot: 516_000_000 }, value: { signature: "Sig", err: null, logs: [] } } },
    };
    expect(parseLogsMessage(JSON.stringify(notification))).toEqual({ kind: "transaction", subscription: 7, slot: 516_000_000, signature: "Sig", failed: false });
    notification.params.result.value.err = { InstructionError: [0, "Custom"] } as never;
    expect(parseLogsMessage(JSON.stringify(notification))).toMatchObject({ failed: true });
    expect(parseLogsMessage("not json")).toEqual({ kind: "other" });
  });
});
