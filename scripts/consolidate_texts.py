#!/usr/bin/env python3
"""Consolidate scattered text resources from Inotia4 game data.

Reads all memorytext_*.dat.jpg files (multi-language) and game.dat.jpg
tables, cross-references text IDs, and outputs a consolidated JSON that
groups texts by category (table name) and aligns translations.

Usage:
    python scripts/consolidate_texts.py
"""
from __future__ import annotations

import json
import lzma
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKDIR = ROOT / "workdir"
OUTPUT_DIR = ROOT / "web_viewer" / "public" / "texts"

# ---------------------------------------------------------------------------
# Table index -> name mapping (extracted from EXCELDATA_Create in libgame.so)
# ---------------------------------------------------------------------------
TABLE_NAMES: dict[int, str] = {
    0: "CHARCLASSBASE",
    1: "STATUSINFOBASE",
    2: "STATUSASSIGNBASE",
    3: "STATUSDICEBASE",
    4: "ATTRINITBASE",
    5: "PORTRAITBASE",
    6: "PORTRAITCLASSBASE",
    7: "CHARACTERSTATEBASE",
    8: "CHARACTERSTATECHANGEBASE",
    9: "CONDITIONBASE",
    10: "EXPRESSBASE",
    11: "CONSTBASE",
    12: "STATUSBASE",
    13: "ITEMDATABASE",
    14: "ITEMCLASSBASE",
    15: "ITEMMIXLINKBASE",
    16: "MANAGEMBASE",
    17: "ITEMRARITYGRADEBASE",
    18: "ITEMGRADEBASE",
    19: "ITEMENCHANTBASE",
    20: "ITEMSTATICBASE",
    21: "ITEMRECOVERBASE",
    22: "ITEMBUFFBASE",
    23: "ITEMOPTINFOBASE",
    24: "ITEMSTATICOPTBASE",
    25: "DEALINFOBASE",
    26: "RECIPEBASE",
    27: "MIXTUREBASE",
    28: "ACTDATABASE",
    29: "ACTUNITBASE",
    30: "ACTTRANSMITBASE",
    31: "BUFFDATABASE",
    32: "BUFFUNITBASE",
    33: "ACTTRANSMIT_ADDBASE",
    34: "SKILLDESCBASE",
    35: "SKILLTRAINPOINTBASE",
    36: "SKILLTRAINBASE",
    37: "CHARACTERCOSTUMEGROUPBASE",
    38: "CHARACTERCOSTUMEBASE",
    39: "CHARACTERCOSTUMEPALETTEBASE",
    40: "IMAGEFILEBASE",
    41: "ANIMATIONAREABASE",
    42: "ANIMATIONTYPEBASE",
    43: "ANIMATIONDEFINEBASE",
    44: "MONSTERCOSTUMEBASE",
    45: "MONSKILLTYPEBASE",
    46: "MONSKILLBASE",
    47: "MONDATABASE",
    48: "MONAIINFOBASE",
    49: "QUESTDROPBASE",
    50: "NPCFUNCBASE",
    51: "NPCINFOBASE",
    52: "NPCFUNCLINKBASE",
    53: "NPCDESCBASE",
    54: "NPCABILITYBASE",
    55: "NPCCOSTUMEBASE",
    56: "MAPFEATUREINFOBASE",
    57: "MAPCOLORBASE",
    58: "MAPINFOBASE",
    59: "EVTINFOBASE",
    60: "EVTCONDBASE",
    61: "EVTCMDBASE",
    62: "EFFECTINFOBASE",
    63: "CHOICEBASE",
    64: "QUESTGROUPBASE",
    65: "QUESTINFOBASE",
    66: "QUESTLINKBASE",
    67: "QUESTCOMPLETEBASE",
    68: "QUESTOBJECTCHANGEBASE",
    69: "QUESTPREPAREBASE",
    70: "QUESTREWARDBASE",
    71: "QUESTGENBASE",
    72: "SYMBOLBASE",
    73: "TEXTDATABASE",
    74: "TIPBASE",
    75: "MONSTERDROPBASE",
    76: "OPENITEMBOXBASE",
    77: "DROPINFOBASE",
    78: "DROPDETAILINFOBASE",
    79: "DROPEVTBASE",
    80: "SOUNDINFOBASE",
    81: "HELPTEXTBASE",
    82: "MAXLEVELBASE",
    83: "INSTALLBASE",
    84: "CASHITEMGROUPBASE",
    85: "CASHITEMBASE",
    86: "ITEMPACKBASE",
    87: "PORTALINFOBASE",
    88: "ITEMDESCBASE",
    89: "COLORRATEBASE",
    90: "COLORRATEDATABASE",
    91: "MERCENARYINFOBASE",
    92: "MERCENARYSKILLBASE",
    93: "MERCENARYGROUPSKILLBASE",
    94: "CHEATCHARBASE",
    95: "CHEATCHARITEMBASE",
    96: "SOUNDEFFECTBASE",
    97: "SOUNDBGMBASE",
    98: "CHARGEDITEMBASE",
    99: "CHARGEDITEMPRODUCTBASE",
}

# Friendly category labels for table groups
TABLE_CATEGORIES: dict[str, str] = {
    "CHARCLASSBASE": "character_class",
    "STATUSINFOBASE": "status_info",
    "STATUSASSIGNBASE": "status_assign",
    "STATUSDICEBASE": "status_dice",
    "ATTRINITBASE": "attribute_init",
    "PORTRAITBASE": "portrait",
    "PORTRAITCLASSBASE": "portrait_class",
    "CHARACTERSTATEBASE": "character_state",
    "CHARACTERSTATECHANGEBASE": "character_state_change",
    "CONDITIONBASE": "condition",
    "EXPRESSBASE": "expression",
    "CONSTBASE": "constant",
    "STATUSBASE": "status",
    "ITEMDATABASE": "item",
    "ITEMCLASSBASE": "item_class",
    "ITEMMIXLINKBASE": "item_mix_link",
    "MANAGEMBASE": "management",
    "ITEMRARITYGRADEBASE": "item_rarity",
    "ITEMGRADEBASE": "item_grade",
    "ITEMENCHANTBASE": "item_enchant",
    "ITEMSTATICBASE": "item_static",
    "ITEMRECOVERBASE": "item_recover",
    "ITEMBUFFBASE": "item_buff",
    "ITEMOPTINFOBASE": "item_opt_info",
    "ITEMSTATICOPTBASE": "item_static_opt",
    "DEALINFOBASE": "deal_info",
    "RECIPEBASE": "recipe",
    "MIXTUREBASE": "mixture",
    "ACTDATABASE": "action",
    "ACTUNITBASE": "action_unit",
    "ACTTRANSMITBASE": "action_transmit",
    "BUFFDATABASE": "buff",
    "BUFFUNITBASE": "buff_unit",
    "ACTTRANSMIT_ADDBASE": "action_transmit_add",
    "SKILLDESCBASE": "skill_desc",
    "SKILLTRAINPOINTBASE": "skill_train_point",
    "SKILLTRAINBASE": "skill_train",
    "CHARACTERCOSTUMEGROUPBASE": "costume_group",
    "CHARACTERCOSTUMEBASE": "costume",
    "CHARACTERCOSTUMEPALETTEBASE": "costume_palette",
    "IMAGEFILEBASE": "image_file",
    "ANIMATIONAREABASE": "animation_area",
    "ANIMATIONTYPEBASE": "animation_type",
    "ANIMATIONDEFINEBASE": "animation_define",
    "MONSTERCOSTUMEBASE": "monster_costume",
    "MONSKILLTYPEBASE": "monster_skill_type",
    "MONSKILLBASE": "monster_skill",
    "MONDATABASE": "monster",
    "MONAIINFOBASE": "monster_ai",
    "QUESTDROPBASE": "quest_drop",
    "NPCFUNCBASE": "npc_func",
    "NPCINFOBASE": "npc_info",
    "NPCFUNCLINKBASE": "npc_func_link",
    "NPCDESCBASE": "npc_desc",
    "NPCABILITYBASE": "npc_ability",
    "NPCCOSTUMEBASE": "npc_costume",
    "MAPFEATUREINFOBASE": "map_feature_info",
    "MAPCOLORBASE": "map_color",
    "MAPINFOBASE": "map_info",
    "EVTINFOBASE": "event_info",
    "EVTCONDBASE": "event_cond",
    "EVTCMDBASE": "event_cmd",
    "EFFECTINFOBASE": "effect_info",
    "CHOICEBASE": "choice",
    "QUESTGROUPBASE": "quest_group",
    "QUESTINFOBASE": "quest_info",
    "QUESTLINKBASE": "quest_link",
    "QUESTCOMPLETEBASE": "quest_complete",
    "QUESTOBJECTCHANGEBASE": "quest_object_change",
    "QUESTPREPAREBASE": "quest_prepare",
    "QUESTREWARDBASE": "quest_reward",
    "QUESTGENBASE": "quest_gen",
    "SYMBOLBASE": "symbol",
    "TEXTDATABASE": "text_data",
    "TIPBASE": "tip",
    "MONSTERDROPBASE": "monster_drop",
    "OPENITEMBOXBASE": "open_item_box",
    "DROPINFOBASE": "drop_info",
    "DROPDETAILINFOBASE": "drop_detail_info",
    "DROPEVTBASE": "drop_event",
    "SOUNDINFOBASE": "sound_info",
    "HELPTEXTBASE": "help_text",
    "MAXLEVELBASE": "max_level",
    "INSTALLBASE": "install",
    "CASHITEMGROUPBASE": "cash_item_group",
    "CASHITEMBASE": "cash_item",
    "ITEMPACKBASE": "item_pack",
    "PORTALINFOBASE": "portal_info",
    "ITEMDESCBASE": "item_desc",
    "COLORRATEBASE": "color_rate",
    "COLORRATEDATABASE": "color_rate_data",
    "MERCENARYINFOBASE": "mercenary_info",
    "MERCENARYSKILLBASE": "mercenary_skill",
    "MERCENARYGROUPSKILLBASE": "mercenary_group_skill",
    "CHEATCHARBASE": "cheat_char",
    "CHEATCHARITEMBASE": "cheat_char_item",
    "SOUNDEFFECTBASE": "sound_effect",
    "SOUNDBGMBASE": "sound_bgm",
    "CHARGEDITEMBASE": "charged_item",
    "CHARGEDITEMPRODUCTBASE": "charged_item_product",
}

# Language codes for memorytext files
LANG_MAP: dict[str, str] = {
    "memorytext": "ko",
    "memorytext_en": "en",
    "memorytext_zhhans": "zh-Hans",
    "memorytext_zhhant": "zh-Hant",
    "memorytext_jp": "ja",
    "memorytext_de": "de",
    "memorytext_fr": "fr",
    "memorytext_e": "es",
}

# Minimum hit ratio for a u16 field to be considered a text_id reference
TEXT_ID_MIN_HIT_RATIO = 0.25
TEXT_ID_MIN_HITS = 3

# ---------------------------------------------------------------------------
# LZMA decompression (same logic as export_map_viewer_dataset.py)
# ---------------------------------------------------------------------------

def _props_to_lclppb(prop: int) -> tuple[int, int, int] | None:
    if prop >= 225:
        return None
    pb = prop // 45
    rem = prop % 45
    lp = rem // 9
    lc = rem % 9
    return lc, lp, pb


def _decode_raw_with_limit(comp: bytes, filters: list[dict[str, Any]], out_size: int) -> bytes:
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filters)
    out = bytearray()
    data = comp
    while len(out) < out_size:
        chunk = dec.decompress(data, max_length=out_size - len(out))
        out.extend(chunk)
        data = b""
        if len(out) >= out_size:
            break
        if not chunk and dec.needs_input:
            break
    return bytes(out)


def decode_standard_outer(data: bytes) -> bytes:
    if len(data) < 16 or data[:4] != b"\x01\x00\x5d\x00":
        raise ValueError("resource is not a standard 0x01 00 5d 00 container")
    props = _props_to_lclppb(data[2])
    if props is None:
        raise ValueError(f"invalid outer LZMA property byte: {data[2]:#x}")
    lc, lp, pb = props
    dict_size = int.from_bytes(data[3:7], "little")
    out_size = int.from_bytes(data[7:11], "little")
    decoded = _decode_raw_with_limit(
        data[15:],
        [{"id": lzma.FILTER_LZMA1, "dict_size": max(dict_size, 4096),
          "lc": lc, "lp": lp, "pb": pb}],
        out_size,
    )
    if len(decoded) != out_size:
        raise ValueError(f"short outer decode: {len(decoded)} != {out_size}")
    return decoded


# ---------------------------------------------------------------------------
# game.dat.jpg excel table parsing
# ---------------------------------------------------------------------------

def parse_excel_tables(blob: bytes) -> list[bytes]:
    table_count = int.from_bytes(blob[:2], "little")
    header_size = 2 + (table_count + 1) * 3
    if header_size > len(blob):
        raise ValueError("excel header extends beyond blob size")
    offsets = [
        int.from_bytes(blob[2 + i * 3 : 5 + i * 3], "little")
        for i in range(table_count + 1)
    ]
    if offsets[0] != 0:
        raise ValueError("excel table offsets do not start at zero")
    return [
        blob[header_size + offsets[i] : header_size + offsets[i + 1]]
        for i in range(table_count)
    ]


def parse_table_records(table_blob: bytes) -> tuple[int, int, bytes] | None:
    if len(table_blob) < 6:
        return None
    record_count = struct.unpack_from("<I", table_blob, 0)[0]
    record_size = struct.unpack_from("<H", table_blob, 4)[0]
    if record_size == 0 or record_count == 0:
        return None
    return record_count, record_size, table_blob[6:]


# ---------------------------------------------------------------------------
# Memorytext parsing
# ---------------------------------------------------------------------------

def parse_memorytext_blob(blob: bytes) -> list[str]:
    if len(blob) < 4:
        raise ValueError("memorytext blob is too small")
    record_count = struct.unpack_from("<I", blob, 0)[0]
    table_end = 4 + record_count * 3
    if table_end > len(blob):
        raise ValueError("memorytext offset table extends beyond blob size")
    offsets: list[int] = []
    for i in range(record_count):
        offset = int.from_bytes(blob[4 + i * 3 : 7 + i * 3], "little")
        offsets.append(offset)
    records: list[str] = []
    for offset in offsets:
        end = blob.find(b"\x00", offset)
        if end == -1:
            end = len(blob)
        records.append(blob[offset:end].decode("utf-8", errors="replace"))
    return records


# ---------------------------------------------------------------------------
# Text ID reference detection
# ---------------------------------------------------------------------------

def scan_table_for_text_ids(
    record_count: int,
    record_size: int,
    body: bytes,
    ref_records: list[str],
) -> list[dict[str, Any]]:
    """Scan a table for u16 fields that consistently map to valid text IDs.

    Uses a spread heuristic to filter out numeric fields (e.g. class_id 1-6)
    that accidentally match valid text IDs.  A genuine text_id field should
    reference a *diverse* set of IDs spread across the text database, not
    cluster in a tiny range.
    """
    max_text_id = len(ref_records) - 1
    actual_rc = min(record_count, len(body) // record_size)
    if actual_rc == 0:
        return []

    hits: list[dict[str, Any]] = []
    for field_offset in range(0, record_size - 1, 2):
        non_zero_valid = 0
        zero_count = 0
        collected_ids: list[int] = []
        for rec_idx in range(actual_rc):
            pos = rec_idx * record_size + field_offset
            if pos + 2 > len(body):
                break
            val = struct.unpack_from("<H", body, pos)[0]
            if val == 0:
                zero_count += 1
            elif 0 < val <= max_text_id and ref_records[val]:
                non_zero_valid += 1
                collected_ids.append(val)

        ratio = non_zero_valid / actual_rc
        if ratio < TEXT_ID_MIN_HIT_RATIO or non_zero_valid < TEXT_ID_MIN_HITS:
            continue

        # Spread heuristic: reject fields whose unique values all fall within
        # a very small range.  Real text_id fields reference IDs spread across
        # a wide range; tiny-range fields are usually enum/index columns.
        unique_ids = sorted(set(collected_ids))
        if unique_ids:
            spread = unique_ids[-1] - unique_ids[0]
            # If there are many unique IDs but they all fit in a range < 20,
            # or if the max ID is very small (< 20), this is likely a
            # numeric field, not a text_id field.
            if spread < 20 and len(unique_ids) < 15 and unique_ids[-1] < 30:
                continue

        hits.append({
            "field_offset": field_offset,
            "hit_count": non_zero_valid,
            "hit_ratio": round(ratio, 3),
            "zero_count": zero_count,
            "sample_ids": unique_ids[:5],
        })

    return hits


# ---------------------------------------------------------------------------
# Main consolidation
# ---------------------------------------------------------------------------

def find_assets_dir() -> Path:
    """Find the game_res directory under workdir/."""
    candidates = list(WORKDIR.glob("*/assets/common/game_res"))
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"Expected exactly 1 game_res directory under workdir/, found {len(candidates)}"
        )
    return candidates[0]


def load_all_memorytext(assets_dir: Path) -> dict[str, list[str]]:
    """Load all memorytext files, keyed by language code."""
    result: dict[str, list[str]] = {}
    for stem, lang_code in LANG_MAP.items():
        path = assets_dir / f"{stem}.dat.jpg"
        if not path.exists():
            print(f"  [skip] {path.name} not found")
            continue
        try:
            blob = decode_standard_outer(path.read_bytes())
            records = parse_memorytext_blob(blob)
            result[lang_code] = records
            non_empty = sum(1 for r in records if r)
            print(f"  {path.name:35s}  lang={lang_code:7s}  records={len(records):6d}  non_empty={non_empty:5d}")
        except Exception as exc:
            print(f"  [error] {path.name}: {exc}")
    return result


def build_multilang_entries(
    all_texts: dict[str, list[str]],
) -> list[dict[str, Any]]:
    """Build a list of entries with all language variants aligned by text_id."""
    # Find the max record count across all languages
    max_count = max(len(records) for records in all_texts.values())
    entries: list[dict[str, Any]] = []

    for text_id in range(max_count):
        translations: dict[str, str] = {}
        any_non_empty = False
        for lang, records in all_texts.items():
            text = records[text_id] if text_id < len(records) else ""
            if text:
                translations[lang] = text
                any_non_empty = True
        if any_non_empty:
            entry: dict[str, Any] = {"text_id": text_id, "texts": translations}
            # Check for markup in any language
            has_markup = any(
                "$" in t or "&" in t for t in translations.values()
            )
            if has_markup:
                entry["has_markup"] = True
            entries.append(entry)

    return entries


def build_table_text_refs(
    assets_dir: Path,
    ref_records: list[str],
) -> list[dict[str, Any]]:
    """Parse game.dat.jpg and find all text_id references in each table."""
    print("\nParsing game.dat.jpg...")
    game_blob = decode_standard_outer((assets_dir / "game.dat.jpg").read_bytes())
    tables = parse_excel_tables(game_blob)
    print(f"  Total tables: {len(tables)}")

    table_refs: list[dict[str, Any]] = []
    for idx, table_blob in enumerate(tables):
        parsed = parse_table_records(table_blob)
        if parsed is None:
            continue
        record_count, record_size, body = parsed
        table_name = TABLE_NAMES.get(idx, f"UNKNOWN_{idx}")
        category = TABLE_CATEGORIES.get(table_name, table_name.lower())

        hits = scan_table_for_text_ids(record_count, record_size, body, ref_records)
        if not hits:
            continue

        # Collect all referenced text_ids from this table
        actual_rc = min(record_count, len(body) // record_size)
        all_text_ids: set[int] = set()
        field_details: list[dict[str, Any]] = []

        for hit in hits:
            fo = hit["field_offset"]
            ids_at_offset: list[int] = []
            for rec_idx in range(actual_rc):
                pos = rec_idx * record_size + fo
                if pos + 2 > len(body):
                    break
                val = struct.unpack_from("<H", body, pos)[0]
                if 0 < val < len(ref_records) and ref_records[val]:
                    ids_at_offset.append(val)
                    all_text_ids.add(val)
            field_details.append({
                "field_offset": fo,
                "hit_count": hit["hit_count"],
                "hit_ratio": hit["hit_ratio"],
                "unique_text_ids": sorted(set(ids_at_offset)),
            })

        table_refs.append({
            "table_index": idx,
            "table_name": table_name,
            "category": category,
            "record_count": record_count,
            "record_size": record_size,
            "text_fields": field_details,
            "all_referenced_text_ids": sorted(all_text_ids),
        })

    return table_refs


def build_text_usage_index(
    table_refs: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    """Build a reverse index: text_id -> list of {table, field_offset, category}."""
    usage: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for tref in table_refs:
        for field in tref["text_fields"]:
            for tid in field["unique_text_ids"]:
                usage[tid].append({
                    "table": tref["table_name"],
                    "table_index": tref["table_index"],
                    "category": tref["category"],
                    "field_offset": field["field_offset"],
                })

    return dict(usage)


def main() -> None:
    assets_dir = find_assets_dir()
    print(f"Assets directory: {assets_dir}\n")

    # ---- Step 1: Load all memorytext files ----
    print("Loading memorytext files...")
    all_texts = load_all_memorytext(assets_dir)
    if not all_texts:
        raise RuntimeError("No memorytext files found")

    # Use zh-Hans as primary reference (or fallback to first available)
    ref_lang = "zh-Hans" if "zh-Hans" in all_texts else next(iter(all_texts))
    ref_records = all_texts[ref_lang]
    print(f"\nPrimary reference language: {ref_lang} ({len(ref_records)} records)")

    # ---- Step 2: Build multi-language aligned entries ----
    print("\nBuilding multi-language text entries...")
    multilang_entries = build_multilang_entries(all_texts)
    print(f"  Non-empty text entries: {len(multilang_entries)}")
    lang_count = len(all_texts)
    full_coverage = sum(
        1 for e in multilang_entries if len(e["texts"]) == lang_count
    )
    print(f"  Entries with all {lang_count} languages: {full_coverage}")

    # ---- Step 3: Find text_id references in game tables ----
    table_refs = build_table_text_refs(assets_dir, ref_records)
    print(f"\n  Tables with text references: {len(table_refs)}")
    total_refs = sum(len(t["all_referenced_text_ids"]) for t in table_refs)
    print(f"  Total unique text_id references: {total_refs}")

    # ---- Step 4: Build usage index ----
    print("\nBuilding text usage index...")
    usage_index = build_text_usage_index(table_refs)
    referenced_ids = set(usage_index.keys())
    print(f"  Text IDs referenced by game tables: {len(referenced_ids)}")

    # Count unreferenced texts
    all_non_empty_ids = {e["text_id"] for e in multilang_entries}
    unreferenced = all_non_empty_ids - referenced_ids
    print(f"  Unreferenced text IDs: {len(unreferenced)}")

    # ---- Step 5: Annotate entries with usage info ----
    print("\nAnnotating text entries with usage info...")
    for entry in multilang_entries:
        tid = entry["text_id"]
        if tid in usage_index:
            refs = usage_index[tid]
            categories = sorted(set(r["category"] for r in refs))
            entry["categories"] = categories
            entry["referenced_by"] = [
                {
                    "table": r["table"],
                    "table_index": r["table_index"],
                    "field_offset": r["field_offset"],
                }
                for r in refs
            ]

    # ---- Step 6: Build category summary ----
    category_summary: dict[str, int] = defaultdict(int)
    for entry in multilang_entries:
        for cat in entry.get("categories", []):
            category_summary[cat] += 1

    # ---- Step 7: Write output ----
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / "consolidated_texts.json"

    output = {
        "description": "Consolidated text resources from Inotia4 game data",
        "languages": sorted(all_texts.keys()),
        "primary_language": ref_lang,
        "total_text_ids": max(len(r) for r in all_texts.values()),
        "non_empty_entries": len(multilang_entries),
        "referenced_by_tables": len(referenced_ids),
        "unreferenced_count": len(unreferenced),
        "category_summary": dict(sorted(category_summary.items())),
        "table_definitions": [
            {
                "table_index": t["table_index"],
                "table_name": t["table_name"],
                "category": t["category"],
                "record_count": t["record_count"],
                "record_size": t["record_size"],
                "text_fields": [
                    {"field_offset": f["field_offset"], "hit_count": f["hit_count"], "hit_ratio": f["hit_ratio"]}
                    for f in t["text_fields"]
                ],
                "referenced_text_count": len(t["all_referenced_text_ids"]),
            }
            for t in table_refs
        ],
        "entries": multilang_entries,
    }

    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nOutput written to: {output_path}")
    print(f"  File size: {output_path.stat().st_size:,} bytes")

    # ---- Summary ----
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Languages:              {', '.join(sorted(all_texts.keys()))}")
    print(f"  Total text IDs:         {max(len(r) for r in all_texts.values()):,}")
    print(f"  Non-empty entries:      {len(multilang_entries):,}")
    print(f"  Referenced by tables:   {len(referenced_ids):,}")
    print(f"  Unreferenced:           {len(unreferenced):,}")
    print(f"  Categories found:       {len(category_summary)}")
    print(f"\n  Category breakdown:")
    for cat, count in sorted(category_summary.items(), key=lambda x: -x[1]):
        print(f"    {cat:30s} {count:5d} text IDs")


if __name__ == "__main__":
    main()
