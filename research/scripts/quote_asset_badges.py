"""Which StonkFun quote assets Meteora DBC, DAMM v2 and DLMM accept, and which hold or need a token badge.

Read-only: public HTTP and Solana RPC reads only, no transaction is built or sent.

Stages (run in order, each caches its result as JSON in CACHE_DIR):
  pairs    StonkFun's public pair list, GET https://stonkfun.xyz/api/public/v1/pairs (and ?launchable=true)
  badges   every TokenBadge account of the three programs (getProgramAccounts, discriminator + size 168)
  mints    every StonkFun mint and every badged mint, jsonParsed (getMultipleAccounts), plus the current epoch
  pdas     derives ["token_badge", mint] per program for each StonkFun mint and checks it against the badge scan
  dbc      DBC usage: quote mint of every PoolConfig and config of every VirtualPool / TransferHookPool
  alpha    quote mint and pool type of every Alpha Vault
  history  the first transaction of every badge account (its creation), with signers and fee payer
  table    joins everything into research/quote-asset-badges.csv and prints the counts used in the write-up

Layouts and rules come from Meteora's sources (pinned commits):
  DBC     MeteoraAg/dynamic-bonding-curve 91e696e (program 0.2.2), programs/dynamic-bonding-curve/src/utils/token.rs
  DAMM v2 MeteoraAg/damm-v2 5398b5c (cp_amm 0.2.5), programs/cp-amm/src/utils/token.rs
  DLMM    MeteoraAg/dlmm-sdk af36dd5 (lb_clmm IDL 0.12.0), commons/src/pda.rs; mint rules from docs.meteora.ag
  Alpha   MeteoraAg/alpha-vault-sdk 1bfa0c8 (alpha_vault IDL 0.4.1), idls/alpha_vault.json
TokenBadge is the same zero-copy struct in all three programs: 8-byte discriminator, token_mint (32), padding (128).
The DBC pool and config offsets are the ones used by Stoker's research/competitors/meteora_dbc_scan.py.

Usage: python3 -I quote_asset_badges.py CACHE_DIR STAGE [STAGE ...]
HELIUS_API_KEY comes from the environment, or from ~/.config/env/global.env when the environment lacks it.
"""
import base64, collections, csv, hashlib, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROGRAMS = {"DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
            "DAMMv2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
            "DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"}
ALPHA_VAULT = "vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2"
SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
T22_NATIVE_MINT = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"
DISC = {
    "TokenBadge": bytes([116, 219, 204, 229, 249, 116, 255, 150]),
    "VirtualPool": bytes([213, 224, 5, 209, 98, 69, 119, 92]),
    "TransferHookPool": bytes([237, 219, 184, 23, 42, 189, 169, 35]),
    "PoolConfig": bytes([26, 108, 14, 123, 116, 230, 129, 43]),
    "ConfigWithTransferHook": bytes([40, 220, 194, 251, 41, 199, 123, 253]),
    "AlphaVault": bytes([211, 8, 232, 43, 2, 152, 117, 119]),
}
STONKFUN = "https://stonkfun.xyz/api/public/v1/pairs"
REPO = Path(__file__).resolve().parent.parent  # research/
ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(b):
    n = int.from_bytes(b, "big"); s = ""
    while n:
        n, r = divmod(n, 58); s = ALPH[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def unb58(s):
    n = 0
    for c in s:
        n = n * 58 + ALPH.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


# ed25519 point decompression, to reproduce Pubkey::find_program_address without dependencies
P = 2 ** 255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def on_curve(b):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= P:
        return False
    u = (y * y - 1) % P; v = (D * y * y + 1) % P
    x = (u * pow(v, 3, P) * pow(u * pow(v, 7, P), (P - 5) // 8, P)) % P
    vx2 = (v * x * x) % P
    return vx2 == u or vx2 == (-u) % P


def find_program_address(seeds, program_id):
    pid = unb58(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + pid + b"ProgramDerivedAddress").digest()
        if not on_curve(h):
            return b58(h), bump
    raise ValueError("no bump")


def api_key():
    k = os.environ.get("HELIUS_API_KEY")
    if k:
        return k
    for line in (Path.home() / ".config/env/global.env").read_text().splitlines():
        line = line.strip().removeprefix("export ")
        if line.startswith("HELIUS_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("HELIUS_API_KEY not set")


_URL = None


def rpc(method, params):
    global _URL
    _URL = _URL or f"https://mainnet.helius-rpc.com/?api-key={api_key()}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(12):
        try:
            req = urllib.request.Request(_URL, body, {"Content-Type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=180))
            if "error" in r:
                raise RuntimeError(r["error"])
            return r["result"]
        except Exception as e:  # noqa: BLE001 - transient RPC failures and 429s are retried
            print("retry", method, attempt, str(e)[:160], file=sys.stderr, flush=True)
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError(f"rpc {method} failed")


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (top-pad research)"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def scan(program, kind, data_slice=None, extra_filters=()):
    """Yield (pubkey, bytes) for every account of one type, 10,000 per page (Helius getProgramAccountsV2)."""
    key = None; pages = 0; n = 0
    while True:
        cfg = {"encoding": "base64", "limit": 10000,
               "filters": [{"memcmp": {"offset": 0, "bytes": b58(DISC[kind])}}, *extra_filters]}
        if data_slice:
            cfg["dataSlice"] = {"offset": data_slice[0], "length": data_slice[1]}
        if key:
            cfg["paginationKey"] = key
        res = rpc("getProgramAccountsV2", [program, cfg])
        for a in res["accounts"]:
            n += 1
            yield a["pubkey"], base64.b64decode(a["account"]["data"][0])
        pages += 1; key = res.get("paginationKey")
        if pages % 20 == 0 or not key:
            print(f"  {kind} page {pages}: {n} accounts", flush=True)
        if not key:
            return


class Cache:
    def __init__(self, d):
        self.d = Path(d); self.d.mkdir(parents=True, exist_ok=True)

    def put(self, name, obj):
        (self.d / f"{name}.json").write_text(json.dumps(obj))

    def get(self, name):
        return json.loads((self.d / f"{name}.json").read_text())


# ---------------------------------------------------------------- stages

def stage_pairs(c):
    full = http_json(STONKFUN); launchable = http_json(STONKFUN + "?launchable=true")
    c.put("stonkfun_pairs", full); c.put("stonkfun_pairs_launchable", launchable)
    print("pairs", len(full["data"]["pairs"]), "launchable", len(launchable["data"]["pairs"]),
          "generatedAt", full["meta"]["generatedAt"])


def stage_badges(c):
    out = {}
    for name, pid in PROGRAMS.items():
        rows = []
        for pk, d in scan(pid, "TokenBadge", extra_filters=[{"dataSize": 168}]):
            rows.append({"badge": pk, "mint": b58(d[8:40]), "padding_nonzero": sum(1 for x in d[40:] if x)})
        out[name] = rows
        print(name, "badges", len(rows))
    c.put("badges", out)


def stage_mints(c):
    mints = [p["mint"] for p in c.get("stonkfun_pairs")["data"]["pairs"]]
    for rows in c.get("badges").values():
        mints += [r["mint"] for r in rows]
    mints = list(dict.fromkeys(mints))
    out = {}
    for i in range(0, len(mints), 100):
        res = rpc("getMultipleAccounts", [mints[i:i + 100], {"encoding": "jsonParsed"}])["value"]
        for m, a in zip(mints[i:i + 100], res):
            out[m] = None if a is None else {"owner": a["owner"], "parsed": a["data"].get("parsed") if isinstance(a["data"], dict) else None}
    epoch = rpc("getEpochInfo", [])["epoch"]
    c.put("mints", {"epoch": epoch, "snapshot": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "mints": out})
    print("mints", len(out), "epoch", epoch)


def stage_pdas(c):
    pairs = c.get("stonkfun_pairs")["data"]["pairs"]
    scanned = {k: {r["mint"]: r["badge"] for r in v} for k, v in c.get("badges").items()}
    out = {}; mismatches = 0
    for name, pid in PROGRAMS.items():
        derived = {p["mint"]: find_program_address([b"token_badge", unb58(p["mint"])], pid)[0] for p in pairs}
        keys = list(derived.values()); exists = {}
        for i in range(0, len(keys), 100):
            res = rpc("getMultipleAccounts", [keys[i:i + 100], {"encoding": "base64", "dataSlice": {"offset": 0, "length": 40}}])["value"]
            for k, a in zip(keys[i:i + 100], res):
                exists[k] = a is not None and a["owner"] == pid
        for m, k in derived.items():
            in_scan = scanned[name].get(m)
            if exists[k] != (in_scan is not None) or (in_scan and in_scan != k):
                mismatches += 1
                print("MISMATCH", name, m, k, in_scan, file=sys.stderr)
        out[name] = {m: {"pda": k, "exists": exists[k]} for m, k in derived.items()}
    c.put("pdas", out)
    print("pda check mismatches:", mismatches)


def stage_dbc(c):
    pid = PROGRAMS["DBC"]
    pools = collections.Counter()
    for kind in ("VirtualPool", "TransferHookPool"):
        for _, d in scan(pid, kind, (72, 32)):  # PoolState.config @72
            pools[b58(d)] += 1
    configs = {}
    for kind in ("PoolConfig", "ConfigWithTransferHook"):
        for pk, d in scan(pid, kind, (8, 32)):  # PoolConfig.quote_mint @8
            configs[pk] = b58(d)
    by_quote = collections.defaultdict(lambda: {"pools": 0, "configs": 0, "configs_with_pools": 0})
    for cfg, q in configs.items():
        by_quote[q]["configs"] += 1
    for cfg, n in pools.items():
        q = configs.get(cfg, "unknown")
        by_quote[q]["pools"] += n; by_quote[q]["configs_with_pools"] += 1
    c.put("dbc_usage", {"snapshot": time.strftime("%Y-%m-%d"), "total_pools": sum(pools.values()),
                        "total_configs": len(configs), "by_quote": by_quote})
    print("dbc pools", sum(pools.values()), "configs", len(configs), "quote mints with configs", len(by_quote))


def stage_alpha(c):
    rows = []
    # Vault: pool @8, quote_mint @104, base_mint @136, nine u64 from @232, bump @304, pool_type @305 (0 DLMM, 1 DAMM v1, 2 DAMM v2)
    for pk, d in scan(ALPHA_VAULT, "AlphaVault", (8, 298)):
        rows.append({"vault": pk, "pool": b58(d[0:32]), "quote_mint": b58(d[96:128]), "base_mint": b58(d[128:160]),
                     "pool_type": d[297]})
    c.put("alpha_vaults", rows)
    print("alpha vaults", len(rows), collections.Counter(r["pool_type"] for r in rows))


def early_signatures(addr, limit):
    """The oldest `limit` signatures that touched addr, oldest first (Helius getTransactionsForAddress)."""
    r = rpc("getTransactionsForAddress", [addr, {"transactionDetails": "signatures", "sortOrder": "asc", "limit": limit}])
    return [d["signature"] for d in (r.get("data") or [])]


BADGE_LOGS = ("Program log: Instruction: CreateTokenBadge", "Program log: Instruction: InitializeTokenBadge")


def fetch_tx(sig):
    t = rpc("getTransaction", [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
    keys = t["transaction"]["message"]["accountKeys"]
    ixs = t["transaction"]["message"]["instructions"]
    logs = t["meta"].get("logMessages") or []
    return {"signature": sig, "slot": t["slot"], "blockTime": t["blockTime"],
            "fee_payer": keys[0]["pubkey"], "signers": [k["pubkey"] for k in keys if k["signer"]],
            "ix_per_program": dict(collections.Counter(i["programId"] for i in ixs)),
            "badge_creations": sum(1 for line in logs if line.startswith(BADGE_LOGS)),
            "err": t["meta"]["err"]}


def stage_history(c):
    """Find the transaction that created each badge: the oldest successful one that logs a badge-creation instruction.

    The oldest transaction touching a badge address is usually its creation, but some are failed transactions
    (for example a pool creation that passed the address before the badge existed), so those are walked forward.
    A previous run's results are reused when present.
    """
    badges = c.get("badges")
    jobs = [(prog, r["badge"], r["mint"]) for prog, rows in badges.items() for r in rows]
    try:
        prev = c.get("badge_history")
        first = {b["badge"]: b["creation"] for b in prev["badges"]}
        txs = {s: t for s, t in prev["transactions"].items() if "badge_creations" in t}
    except FileNotFoundError:
        first, txs = {}, {}
    todo = [j for j in jobs if j[1] not in first]
    with ThreadPoolExecutor(4) as ex:
        for j, sigs in zip(todo, ex.map(lambda j: early_signatures(j[1], 1), todo)):
            first[j[1]] = sigs[0] if sigs else None
    missing = sorted({s for s in first.values() if s and s not in txs})
    with ThreadPoolExecutor(4) as ex:
        for t in ex.map(fetch_tx, missing):
            txs[t["signature"]] = t
    ok = lambda s: s in txs and txs[s]["err"] is None and txs[s]["badge_creations"] > 0  # noqa: E731
    creation = {}
    for _, badge, _ in jobs:
        s = first[badge]
        if s and ok(s):
            creation[badge] = s
            continue
        creation[badge] = None
        for s in early_signatures(badge, 25):
            if s not in txs:
                txs[s] = fetch_tx(s)
            if ok(s):
                creation[badge] = s
                break
    out = [{"program": p, "badge": b, "mint": m, "creation": creation[b]} for p, b, m in jobs]
    print("badges", len(jobs), "creation found", sum(1 for o in out if o["creation"]),
          "distinct creation transactions", len({o["creation"] for o in out if o["creation"]}))
    c.put("badge_history", {"badges": out, "transactions": txs})


# ---------------------------------------------------------------- classification

def ext_map(parsed):
    return {e["extension"]: e.get("state") for e in (parsed or {}).get("info", {}).get("extensions", [])}


def fee_info(ext, epoch):
    """Transfer fee per DBC's is_transfer_fee_zero: (current_bps, scheduled_bps, zero, authority_live)."""
    tf = ext.get("transferFeeConfig")
    if tf is None:
        return None
    older, newer = tf["olderTransferFee"], tf["newerTransferFee"]
    zero_fee = lambda f: f["transferFeeBasisPoints"] == 0 or int(f["maximumFee"]) == 0  # noqa: E731
    if epoch < newer["epoch"]:
        current, scheduled = older, newer
        zero = zero_fee(older) and zero_fee(newer)
    else:
        current, scheduled = newer, None
        zero = zero_fee(newer)
    return {"current_bps": current["transferFeeBasisPoints"],
            "scheduled_bps": scheduled["transferFeeBasisPoints"] if scheduled else None,
            "zero": zero, "authority_live": tf.get("transferFeeConfigAuthority") is not None}


def hook_info(ext):
    th = ext.get("transferHook")
    if th is None:
        return None
    return {"program_set": th.get("programId") is not None, "authority_set": th.get("authority") is not None}


DBC_FREE = {"metadataPointer", "tokenMetadata"}
POOL_FREE = {"transferFeeConfig", "metadataPointer", "tokenMetadata"}  # DAMM v2 and DLMM, plus revoked TransferHook


def classify(mint, acct, epoch, badged):
    """Return per-program status strings following each program's mint validation."""
    if acct is None:
        return {"error": "mint account not found"}
    owner = acct["owner"]; info = (acct["parsed"] or {}).get("info", {})
    ext = ext_map(acct["parsed"]); fee = fee_info(ext, epoch); hook = hook_info(ext)
    freeze = info.get("freezeAuthority") is not None
    active_hook = bool(hook and hook["program_set"])
    out = {"freeze": freeze, "fee": fee, "hook": hook, "ext": sorted(ext), "owner": owner}
    if owner == SPL_TOKEN:
        out.update(DBC="permissionless", DAMMv2="permissionless", DLMM="permissionless")
        return out
    if owner != TOKEN_2022:
        out.update(DBC="not a token mint", DAMMv2="not a token mint", DLMM="not a token mint")
        return out
    if mint == T22_NATIVE_MINT:
        out.update(DBC="rejected", DAMMv2="rejected", DLMM="rejected")
        return out

    # DBC 0.2.2 is_permissionless_supported_quote_mint
    dbc_free = all(e in DBC_FREE or (e == "transferFeeConfig" and fee["zero"] and not fee["authority_live"]) for e in ext)
    if dbc_free:
        dbc = "permissionless"
    elif badged["DBC"]:
        if active_hook:
            dbc = "badged, but quote transfers fail (active transfer hook)"
        elif fee and (not fee["zero"] or fee["authority_live"]):
            dbc = "badged, create_config2 only (transfer fee or live fee authority)"
        else:
            dbc = "badged"
    else:
        dbc = "needs badge" + (" (would still fail: active transfer hook)" if active_hook else "")

    # DAMM v2 0.2.5 is_permissionless_supported_mint
    pool_free = all(e in POOL_FREE or (e == "transferHook" and not hook["program_set"] and not hook["authority_set"]) for e in ext)
    if pool_free:
        damm = "permissionless"
    elif badged["DAMMv2"]:
        damm = "badged" + (", but transfers fail (active transfer hook)" if active_hook else "")
    else:
        damm = "needs badge" + (" (would still fail: active transfer hook)" if active_hook else "")

    # DLMM: same extension allowlist as DAMM v2, and a Token-2022 freeze authority is not permissionless (docs)
    if pool_free and not freeze:
        dlmm = "permissionless"
    elif badged["DLMM"]:
        dlmm = "badged"
    else:
        dlmm = "needs badge" + (" (freeze authority only)" if pool_free and freeze else "")
    out.update(DBC=dbc, DAMMv2=damm, DLMM=dlmm)
    return out


def stage_table(c):
    pairs = c.get("stonkfun_pairs")["data"]["pairs"]
    launchable = {p["mint"] for p in c.get("stonkfun_pairs_launchable")["data"]["pairs"]}
    m = c.get("mints"); epoch = m["epoch"]; accts = m["mints"]
    badges = {k: {r["mint"] for r in v} for k, v in c.get("badges").items()}
    pdas = c.get("pdas")
    usage = c.get("dbc_usage")["by_quote"]
    alpha = collections.Counter(r["quote_mint"] for r in c.get("alpha_vaults"))
    hist = c.get("badge_history")
    created = {(b["program"], b["mint"]): time.strftime("%Y-%m-%d", time.gmtime(hist["transactions"][b["creation"]]["blockTime"]))
               for b in hist["badges"] if b["creation"]}
    rows = []
    for p in pairs:
        mint = p["mint"]; a = accts.get(mint)
        badged = {k: mint in badges[k] for k in PROGRAMS}
        cl = classify(mint, a, epoch, badged)
        info = ((a or {}).get("parsed") or {}).get("info", {})
        fee = cl.get("fee"); hook = cl.get("hook")
        u = usage.get(mint, {})
        rows.append({
            "mint": mint, "symbol": p["symbol"], "name": p["name"],
            "stonkfun_category": p["category"], "stonkfun_launchable_filter": mint in launchable,
            "token_program": {SPL_TOKEN: "SPL Token", TOKEN_2022: "Token-2022"}.get(cl.get("owner"), cl.get("owner")),
            "extensions": " ".join(cl.get("ext", [])),
            "freeze_authority_set": cl.get("freeze"), "freeze_authority": info.get("freezeAuthority") or "",
            "mint_authority_set": info.get("mintAuthority") is not None,
            "transfer_fee_bps_current": "" if not fee else fee["current_bps"],
            "transfer_fee_bps_scheduled": "" if not fee or fee["scheduled_bps"] is None else fee["scheduled_bps"],
            "transfer_fee_authority_live": "" if not fee else fee["authority_live"],
            "transfer_hook": "" if not hook else ("active" if hook["program_set"] else ("authority only" if hook["authority_set"] else "revoked")),
            "dbc_badge": badged["DBC"], "damm_v2_badge": badged["DAMMv2"], "dlmm_badge": badged["DLMM"],
            "dbc_badge_created": created.get(("DBC", mint), ""), "damm_v2_badge_created": created.get(("DAMMv2", mint), ""),
            "dlmm_badge_created": created.get(("DLMM", mint), ""),
            "dbc_status": cl.get("DBC"), "damm_v2_status": cl.get("DAMMv2"), "dlmm_status": cl.get("DLMM"),
            "in_use_on_dbc": u.get("pools", 0) > 0, "dbc_pools": u.get("pools", 0), "dbc_configs": u.get("configs", 0),
            "alpha_vaults_with_this_quote": alpha.get(mint, 0),
            "dbc_badge_pda": pdas["DBC"][mint]["pda"], "damm_v2_badge_pda": pdas["DAMMv2"][mint]["pda"],
            "dlmm_badge_pda": pdas["DLMM"][mint]["pda"],
        })
    path = REPO / "quote-asset-badges.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)
    print("wrote", path, len(rows))
    c.put("table", rows)


STAGES = {"pairs": stage_pairs, "badges": stage_badges, "mints": stage_mints, "pdas": stage_pdas, "dbc": stage_dbc,
          "alpha": stage_alpha, "history": stage_history, "table": stage_table}

if __name__ == "__main__":
    cache = Cache(sys.argv[1])
    for s in sys.argv[2:]:
        print("==", s, flush=True)
        STAGES[s](cache)
