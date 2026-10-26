"""Does DLMM's program itself refuse a Token-2022 mint with a freeze authority when no token badge is passed?

Builds an unsigned DLMM initialize_lb_pair2 transaction for a mint paired with wrapped SOL and runs it through
simulateTransaction (sigVerify false, replaceRecentBlockhash true). Nothing is signed or sent; the simulation only
reports the program logs. Account order and data follow MeteoraAg/dlmm-sdk af36dd5 idls/dlmm.json (lb_clmm 0.12.0)
and commons/src/pda.rs.

Usage: python3 -I dlmm_freeze_simulation.py FUNDER MINT[:badge] [MINT[:badge] ...]
  FUNDER  any funded system account, used only as the simulated fee payer and rent payer
  :badge  pass the mint's DLMM TokenBadge PDA instead of leaving token_badge_x empty
"""
import base64, struct, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import quote_asset_badges as q  # noqa: E402

DLMM = q.PROGRAMS["DLMM"]
WSOL = "So11111111111111111111111111111111111111112"
SYSTEM = "11111111111111111111111111111111"
IX_INIT_LB_PAIR2 = bytes([73, 59, 36, 120, 237, 83, 108, 198])
PRESET2_DISC = bytes([171, 236, 148, 115, 162, 113, 222, 174])


def pda(seeds):
    return q.find_program_address(seeds, DLMM)[0]


def shortvec(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b); return bytes(out)


def build_tx(funder, metas, data, program_id):
    """Legacy message with one signer (funder); metas = [(pubkey, is_signer, is_writable)]."""
    keys = {}
    for k, s, w in [(funder, True, True)] + metas + [(program_id, False, False)]:
        s0, w0 = keys.get(k, (False, False)); keys[k] = (s0 or s, w0 or w)
    order = sorted(keys, key=lambda k: (not keys[k][0], not keys[k][1]))
    order.remove(funder); order.insert(0, funder)
    n_sig = sum(1 for k in order if keys[k][0])
    n_ro_signed = sum(1 for k in order if keys[k][0] and not keys[k][1])
    n_ro_unsigned = sum(1 for k in order if not keys[k][0] and not keys[k][1])
    idx = {k: i for i, k in enumerate(order)}
    msg = bytes([n_sig, n_ro_signed, n_ro_unsigned]) + shortvec(len(order)) + b"".join(q.unb58(k).rjust(32, b"\0") for k in order)
    msg += q.unb58("11111111111111111111111111111111").rjust(32, b"\0")  # blockhash, replaced by the simulator
    msg += shortvec(1) + bytes([idx[program_id]]) + shortvec(len(metas)) + bytes(idx[k] for k, _, _ in metas)
    msg += shortvec(len(data)) + data
    return shortvec(n_sig) + b"\0" * 64 * n_sig + msg


def main():
    funder = sys.argv[1]
    presets = q.rpc("getProgramAccounts", [DLMM, {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0},
                                                  "filters": [{"memcmp": {"offset": 0, "bytes": q.b58(PRESET2_DISC)}}]}])
    preset = sorted(p["pubkey"] for p in presets)[0]
    print("preset_parameter2 used:", preset, f"(one of {len(presets)})")
    event_authority = pda([b"__event_authority"])
    for arg in sys.argv[2:]:
        mint, _, flag = arg.partition(":")
        acct = q.rpc("getAccountInfo", [mint, {"encoding": "jsonParsed"}])["value"]
        token_program = acct["owner"]
        lo, hi = sorted([q.unb58(mint).rjust(32, b"\0"), q.unb58(WSOL).rjust(32, b"\0")])
        lb_pair = pda([q.unb58(preset), lo, hi])
        exists = q.rpc("getAccountInfo", [lb_pair, {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0}}])["value"]
        badge = pda([b"token_badge", q.unb58(mint)]) if flag == "badge" else DLMM
        metas = [
            (lb_pair, False, True),
            (DLMM, False, False),  # bin_array_bitmap_extension: None
            (mint, False, False),
            (WSOL, False, False),
            (pda([q.unb58(lb_pair), q.unb58(mint)]), False, True),
            (pda([q.unb58(lb_pair), q.unb58(WSOL)]), False, True),
            (pda([b"oracle", q.unb58(lb_pair)]), False, True),
            (preset, False, False),
            (funder, True, True),
            (badge, False, False),  # token_badge_x
            (DLMM, False, False),  # token_badge_y: None (wrapped SOL is SPL Token)
            (token_program, False, False),
            (q.SPL_TOKEN, False, False),
            (SYSTEM, False, False),
            (event_authority, False, False),
            (DLMM, False, False),
        ]
        data = IX_INIT_LB_PAIR2 + struct.pack("<i", 0) + bytes(96)
        tx = build_tx(funder, metas, data, DLMM)
        sim = q.rpc("simulateTransaction", [base64.b64encode(tx).decode(), {"encoding": "base64", "sigVerify": False,
                                                                             "replaceRecentBlockhash": True}])["value"]
        info = acct["data"]["parsed"]["info"]
        exts = [e["extension"] for e in info.get("extensions", [])]
        print(f"\n{mint} badge_passed={flag == 'badge'} program={token_program[:6]} freeze={info.get('freezeAuthority') is not None} "
              f"extensions={exts} lb_pair_exists={exists is not None}")
        print("  err:", sim["err"])
        for line in (sim.get("logs") or [])[-8:]:
            print("   ", line[:200])


if __name__ == "__main__":
    main()
