#!/usr/bin/env python3
"""Consolidate Chinese text resources from Inotia4 game data.

Reads `memorytext_zhhans.dat.jpg` and `game.dat.jpg`, cross-references
text IDs, and outputs a consolidated JSON that groups Chinese texts by
the table categories that reference them.

Usage:
    python scripts/consolidate_texts.py
"""
from __future__ import annotations

import json
import lzma
import shutil
import struct
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
APK_INPUT_DIR = ROOT / "apk"
WORKDIR = ROOT / "workdir"
OUTPUT_DIR = ROOT / "web_viewer" / "data" / "texts"
RESOURCE_RELATIVE_DIR = Path("assets") / "common" / "game_res"
TARGET_MEMORYTEXT_STEM = "memorytext_zhhans"
TARGET_LANGUAGE = "zh-Hans"

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
TABLE_INDEX_BY_NAME: dict[str, int] = {name: idx for idx, name in TABLE_NAMES.items()}

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

# Minimum hit ratio for a u16 field to be considered a text_id reference
TEXT_ID_MIN_HIT_RATIO = 0.25
TEXT_ID_MIN_HITS = 3

EVENT_OPCODE_KINDS: dict[int, str] = {
    2: "dialogue",
    45: "narration",
    52: "choice",
    76: "overlay_text",
}

EVENT_SPEAKER_TYPE_LABELS: dict[int, str] = {
    0: "player",
    1: "runtime_actor",
    2: "npc",
}

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


def parse_flat_record_blob(blob: bytes) -> tuple[int, int, bytes]:
    if len(blob) < 6:
        raise ValueError("record blob is too small")
    record_count = struct.unpack_from("<I", blob, 0)[0]
    record_size = struct.unpack_from("<H", blob, 4)[0]
    if record_count == 0 or record_size == 0:
        raise ValueError("record blob has zero-sized header")
    body = blob[6:]
    expected_size = record_count * record_size
    if expected_size > len(body):
        raise ValueError(
            f"record blob body is truncated: expected {expected_size} bytes, got {len(body)}"
        )
    return record_count, record_size, body[:expected_size]


def read_u8(blob: bytes, offset: int) -> int:
    return blob[offset]


def read_u16(blob: bytes, offset: int) -> int:
    return struct.unpack_from("<H", blob, offset)[0]


def read_u32(blob: bytes, offset: int) -> int:
    return struct.unpack_from("<I", blob, offset)[0]


def get_record_slice(body: bytes, record_size: int, index: int) -> bytes | None:
    start = index * record_size
    end = start + record_size
    if start < 0 or end > len(body):
        return None
    return body[start:end]


def iter_record_slices(record_count: int, record_size: int, body: bytes) -> list[tuple[int, bytes]]:
    actual_rc = min(record_count, len(body) // record_size)
    return [
        (index, body[index * record_size : (index + 1) * record_size])
        for index in range(actual_rc)
    ]


def get_text(records: list[str], text_id: int) -> str:
    if 0 <= text_id < len(records):
        return records[text_id]
    return ""


def strip_text_markup(text: str) -> str:
    out = text.replace("&P", "\n\n").replace("&N", "\n")
    for code in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        out = out.replace(f"${code}", "")
    return "\n".join(line.rstrip() for line in out.splitlines()).strip()


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
# APK / asset discovery
# ---------------------------------------------------------------------------

def discover_single_apk() -> Path:
    apk_paths = sorted(APK_INPUT_DIR.glob("*.apk"))
    if not apk_paths:
        raise FileNotFoundError(
            f"Expected exactly 1 APK under {APK_INPUT_DIR}, found none"
        )
    if len(apk_paths) != 1:
        joined = ", ".join(path.name for path in apk_paths)
        raise FileNotFoundError(
            f"Expected exactly 1 APK under {APK_INPUT_DIR}, found {len(apk_paths)}: {joined}"
        )
    return apk_paths[0]


def extract_assets_dir(apk_path: Path) -> Path:
    if WORKDIR.exists():
        shutil.rmtree(WORKDIR)

    extract_root = WORKDIR / apk_path.stem
    extract_root.mkdir(parents=True, exist_ok=True)
    print(f"Extracting {apk_path.name} -> {extract_root}")
    with zipfile.ZipFile(apk_path) as archive:
        archive.extractall(extract_root)

    assets_dir = extract_root / RESOURCE_RELATIVE_DIR
    if not assets_dir.is_dir():
        raise FileNotFoundError(f"Missing resource directory after extraction: {assets_dir}")
    return assets_dir


def find_assets_dir() -> Path:
    """Find the game_res directory under workdir/, or build it from the APK."""
    candidates = list(WORKDIR.glob("*/assets/common/game_res"))
    if not candidates:
        apk_path = discover_single_apk()
        return extract_assets_dir(apk_path)
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"Expected exactly 1 game_res directory under workdir/, found {len(candidates)}"
        )
    return candidates[0]


def load_primary_memorytext(assets_dir: Path) -> list[str]:
    """Load the simplified Chinese memorytext file."""
    path = assets_dir / f"{TARGET_MEMORYTEXT_STEM}.dat.jpg"
    if not path.exists():
        raise FileNotFoundError(f"Missing required text resource: {path}")

    blob = decode_standard_outer(path.read_bytes())
    records = parse_memorytext_blob(blob)
    non_empty = sum(1 for r in records if r)
    print(
        f"  {path.name:35s}  lang={TARGET_LANGUAGE:7s}  "
        f"records={len(records):6d}  non_empty={non_empty:5d}"
    )
    return records


def load_game_tables(assets_dir: Path) -> list[bytes]:
    print("\nParsing game.dat.jpg...")
    game_blob = decode_standard_outer((assets_dir / "game.dat.jpg").read_bytes())
    tables = parse_excel_tables(game_blob)
    print(f"  Total tables: {len(tables)}")
    return tables


def get_game_table(
    tables: list[bytes],
    table_name: str,
) -> tuple[int, int, int, bytes]:
    table_index = TABLE_INDEX_BY_NAME[table_name]
    parsed = parse_table_records(tables[table_index])
    if parsed is None:
        raise ValueError(f"{table_name} is empty or malformed")
    record_count, record_size, body = parsed
    return table_index, record_count, record_size, body


def build_text_entries(
    records: list[str],
) -> list[dict[str, Any]]:
    """Build a list of non-empty simplified Chinese text entries."""
    entries: list[dict[str, Any]] = []
    for text_id, text in enumerate(records):
        if not text:
            continue
        entry: dict[str, Any] = {"text_id": text_id, "text": text}
        if "$" in text or "&" in text:
            entry["has_markup"] = True
        entries.append(entry)

    return entries


def build_table_text_refs(
    tables: list[bytes],
    ref_records: list[str],
) -> list[dict[str, Any]]:
    """Parse game.dat.jpg and find all text_id references in each table."""
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


def build_npc_name_map(
    tables: list[bytes],
    text_records: list[str],
) -> dict[int, dict[str, Any]]:
    _, record_count, record_size, body = get_game_table(tables, "NPCINFOBASE")
    npc_map: dict[int, dict[str, Any]] = {}
    for npc_id, record in iter_record_slices(record_count, record_size, body):
        name_text_id = read_u16(record, 0)
        name = get_text(text_records, name_text_id)
        npc_map[npc_id] = {
            "key": f"npc:{npc_id}",
            "type": "npc",
            "object_type": 2,
            "object_id": npc_id,
            "label": name or f"NPC#{npc_id}",
            "name_text_id": name_text_id,
            "resolved": bool(name),
            "source": "NPCINFOBASE",
        }
    return npc_map


def build_monster_name_map(
    tables: list[bytes],
    text_records: list[str],
) -> dict[int, dict[str, Any]]:
    _, record_count, record_size, body = get_game_table(tables, "MONDATABASE")
    monster_map: dict[int, dict[str, Any]] = {}
    for monster_id, record in iter_record_slices(record_count, record_size, body):
        name_text_id = read_u16(record, 0)
        name = get_text(text_records, name_text_id)
        monster_map[monster_id] = {
            "key": f"runtime_actor:{monster_id}",
            "type": "runtime_actor",
            "object_type": 1,
            "object_id": monster_id,
            "label": name or f"剧情角色#{monster_id}",
            "name_text_id": name_text_id,
            "resolved": bool(name),
            "source": "MONDATABASE",
        }
    return monster_map


def build_npc_description_relations(
    tables: list[bytes],
    text_records: list[str],
) -> dict[str, Any]:
    _, npc_count, npc_size, npc_body = get_game_table(tables, "NPCINFOBASE")
    _, desc_count, desc_size, desc_body = get_game_table(tables, "NPCDESCBASE")

    entries: list[dict[str, Any]] = []
    for relation_id, desc_record in iter_record_slices(desc_count, desc_size, desc_body):
        npc_id = read_u16(desc_record, 0)
        desc_text_id = read_u16(desc_record, 2)
        npc_record = get_record_slice(npc_body, npc_size, npc_id)
        if npc_id >= npc_count or npc_record is None:
            continue

        name_text_id = read_u16(npc_record, 0)
        name = get_text(text_records, name_text_id)
        description = get_text(text_records, desc_text_id)
        if not name and not description:
            continue

        entries.append({
            "relation_id": relation_id,
            "npc_id": npc_id,
            "name_text_id": name_text_id,
            "name": name,
            "description_text_id": desc_text_id,
            "description": description,
        })

    return {
        "table_name": "NPCDESCBASE",
        "count": len(entries),
        "entries": entries,
    }


def build_item_description_relations(
    tables: list[bytes],
    text_records: list[str],
) -> dict[str, Any]:
    _, item_count, item_size, item_body = get_game_table(tables, "ITEMDATABASE")
    _, desc_count, desc_size, desc_body = get_game_table(tables, "ITEMDESCBASE")

    entries: list[dict[str, Any]] = []
    for relation_id, desc_record in iter_record_slices(desc_count, desc_size, desc_body):
        item_id = read_u16(desc_record, 0)
        desc_text_id = read_u16(desc_record, 2)
        item_record = get_record_slice(item_body, item_size, item_id)
        if item_id >= item_count or item_record is None:
            continue

        name_text_id = read_u16(item_record, 0)
        name = get_text(text_records, name_text_id)
        description = get_text(text_records, desc_text_id)
        if not name and not description:
            continue

        entries.append({
            "relation_id": relation_id,
            "item_id": item_id,
            "name_text_id": name_text_id,
            "name": name,
            "description_text_id": desc_text_id,
            "description": description,
        })

    return {
        "table_name": "ITEMDESCBASE",
        "count": len(entries),
        "entries": entries,
    }


def build_choice_relations(
    tables: list[bytes],
    text_records: list[str],
) -> dict[str, Any]:
    _, record_count, record_size, body = get_game_table(tables, "CHOICEBASE")

    entries: list[dict[str, Any]] = []
    for choice_id, record in iter_record_slices(record_count, record_size, body):
        prompt_text_id = read_u16(record, 0)
        prompt = get_text(text_records, prompt_text_id)
        options: list[dict[str, Any]] = []
        for option_slot, offset in enumerate(range(2, record_size, 2), start=1):
            option_text_id = read_u16(record, offset)
            option_text = get_text(text_records, option_text_id)
            if not option_text:
                continue
            options.append({
                "slot": option_slot,
                "text_id": option_text_id,
                "text": option_text,
            })

        if not prompt and not options:
            continue

        entries.append({
            "choice_id": choice_id,
            "prompt_text_id": prompt_text_id,
            "prompt": prompt,
            "options": options,
        })

    return {
        "table_name": "CHOICEBASE",
        "count": len(entries),
        "entries": entries,
    }


def build_quest_text_relations(
    tables: list[bytes],
    text_records: list[str],
) -> dict[str, Any]:
    _, record_count, record_size, body = get_game_table(tables, "QUESTINFOBASE")
    field_defs = [
        ("title", 2),
        ("detail", 14),
        ("progress", 16),
        ("completion", 18),
    ]

    entries: list[dict[str, Any]] = []
    for quest_id, record in iter_record_slices(record_count, record_size, body):
        entry: dict[str, Any] = {"quest_id": quest_id}
        has_text = False
        for field_name, offset in field_defs:
            text_id = read_u16(record, offset)
            text = get_text(text_records, text_id)
            entry[f"{field_name}_text_id"] = text_id
            entry[field_name] = text
            if text:
                has_text = True
        if has_text:
            entries.append(entry)

    return {
        "table_name": "QUESTINFOBASE",
        "count": len(entries),
        "entries": entries,
    }


def build_static_relationships(
    tables: list[bytes],
    text_records: list[str],
) -> dict[str, Any]:
    npc_descriptions = build_npc_description_relations(tables, text_records)
    item_descriptions = build_item_description_relations(tables, text_records)
    choice_sets = build_choice_relations(tables, text_records)
    quest_texts = build_quest_text_relations(tables, text_records)

    return {
        "description": "Static Chinese text relationships recovered from game tables",
        "language": TARGET_LANGUAGE,
        "source_files": ["game.dat.jpg", f"{TARGET_MEMORYTEXT_STEM}.dat.jpg"],
        "npc_descriptions": npc_descriptions,
        "item_descriptions": item_descriptions,
        "choice_sets": choice_sets,
        "quest_texts": quest_texts,
    }


def resolve_event_speaker(
    object_type: int,
    object_id: int,
    npc_name_map: dict[int, dict[str, Any]],
    monster_name_map: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    if object_type == 0 and object_id == 0:
        return {
            "key": "player:0",
            "type": "player",
            "object_type": object_type,
            "object_id": object_id,
            "label": "主角",
            "resolved": True,
            "source": "inferred_main_player",
        }

    if object_type == 2 and object_id in npc_name_map:
        return dict(npc_name_map[object_id])

    if object_type == 1 and object_id in monster_name_map:
        return dict(monster_name_map[object_id])

    speaker_type = EVENT_SPEAKER_TYPE_LABELS.get(object_type, "unknown")
    if speaker_type == "runtime_actor":
        label = f"剧情角色#{object_id}"
    elif speaker_type == "player":
        label = f"玩家角色#{object_id}"
    else:
        label = f"对象[{object_type}:{object_id}]"

    return {
        "key": f"{speaker_type}:{object_id}",
        "type": speaker_type,
        "object_type": object_type,
        "object_id": object_id,
        "label": label,
        "resolved": False,
        "source": "event_object",
    }


def build_event_dialogues(
    assets_dir: Path,
    tables: list[bytes],
    text_records: list[str],
    choice_sets: dict[str, Any],
) -> dict[str, Any]:
    _, event_count, event_size, event_body = get_game_table(tables, "EVTINFOBASE")
    npc_name_map = build_npc_name_map(tables, text_records)
    monster_name_map = build_monster_name_map(tables, text_records)
    choice_lookup = {
        entry["choice_id"]: entry
        for entry in choice_sets["entries"]
    }

    event_blob = decode_standard_outer((assets_dir / "eventdata.dat.jpg").read_bytes())
    data_count, data_size, data_body = parse_flat_record_blob(event_blob)

    speaker_stats: dict[str, dict[str, Any]] = {}
    kind_counts: dict[str, int] = defaultdict(int)
    events: list[dict[str, Any]] = []

    for event_index, event_record in iter_record_slices(event_count, event_size, event_body):
        data_start_index = read_u16(event_record, 3)
        command_count = read_u16(event_record, 5)
        if command_count == 0 or data_start_index >= data_count:
            continue

        entries: list[dict[str, Any]] = []
        actual_count = min(command_count, data_count - data_start_index)
        for sequence in range(actual_count):
            command_index = data_start_index + sequence
            command_record = get_record_slice(data_body, data_size, command_index)
            if command_record is None:
                break

            opcode = read_u8(command_record, 0)
            kind = EVENT_OPCODE_KINDS.get(opcode)
            if kind is None:
                continue

            object_type = read_u8(command_record, 1)
            object_id = read_u16(command_record, 2)
            param = read_u32(command_record, 4)
            text_id = read_u16(command_record, 8)
            text = get_text(text_records, text_id)

            if opcode == 52:
                choice_id = object_type
                entry = {
                    "sequence": sequence,
                    "command_index": command_index,
                    "opcode": opcode,
                    "kind": kind,
                    "choice_id": choice_id,
                    "choice": choice_lookup.get(choice_id),
                    "raw_object_type": object_type,
                    "raw_object_id": object_id,
                    "raw_param": param,
                }
                entries.append(entry)
                kind_counts[kind] += 1
                continue

            if not text:
                continue

            entry = {
                "sequence": sequence,
                "command_index": command_index,
                "opcode": opcode,
                "kind": kind,
                "raw_object_type": object_type,
                "raw_object_id": object_id,
                "raw_param": param,
                "text_id": text_id,
                "text": text,
                "plain_text": strip_text_markup(text),
            }

            if opcode == 2:
                speaker = resolve_event_speaker(
                    object_type,
                    object_id,
                    npc_name_map,
                    monster_name_map,
                )
                entry["speaker"] = speaker
                speaker_stat = speaker_stats.setdefault(
                    speaker["key"],
                    {"speaker": speaker, "line_count": 0},
                )
                speaker_stat["line_count"] += 1

            entries.append(entry)
            kind_counts[kind] += 1

        if not entries:
            continue

        preview_source = next(
            (
                entry.get("plain_text")
                or entry.get("text")
                or entry.get("choice", {}).get("prompt", "")
                for entry in entries
                if entry.get("kind") != "choice" or entry.get("choice")
            ),
            "",
        )
        events.append({
            "event_index": event_index,
            "event_code": read_u16(event_record, 0),
            "event_type": read_u8(event_record, 2),
            "data_start_index": data_start_index,
            "command_count": command_count,
            "ui_flag": read_u8(event_record, 7),
            "entry_count": len(entries),
            "preview_text": preview_source,
            "entries": entries,
        })

    speaker_catalog = sorted(
        speaker_stats.values(),
        key=lambda item: (-item["line_count"], item["speaker"]["key"]),
    )

    return {
        "description": "Event dialogue and narration recovered from eventdata.dat",
        "language": TARGET_LANGUAGE,
        "source_files": ["game.dat.jpg", "eventdata.dat.jpg", f"{TARGET_MEMORYTEXT_STEM}.dat.jpg"],
        "event_count": len(events),
        "eventdata_record_count": data_count,
        "eventdata_record_size": data_size,
        "opcode_kinds": EVENT_OPCODE_KINDS,
        "kind_counts": dict(sorted(kind_counts.items())),
        "speaker_catalog": speaker_catalog,
        "events": events,
    }


def main() -> None:
    assets_dir = find_assets_dir()
    print(f"Assets directory: {assets_dir}\n")

    # ---- Step 1: Load simplified Chinese memorytext ----
    print(f"Loading {TARGET_MEMORYTEXT_STEM}.dat.jpg...")
    ref_records = load_primary_memorytext(assets_dir)
    print(f"\nPrimary reference language: {TARGET_LANGUAGE} ({len(ref_records)} records)")

    # ---- Step 2: Build text entries ----
    print("\nBuilding Chinese text entries...")
    text_entries = build_text_entries(ref_records)
    print(f"  Non-empty text entries: {len(text_entries)}")

    # ---- Step 3: Find text_id references in game tables ----
    tables = load_game_tables(assets_dir)
    table_refs = build_table_text_refs(tables, ref_records)
    print(f"\n  Tables with text references: {len(table_refs)}")
    total_refs = sum(len(t["all_referenced_text_ids"]) for t in table_refs)
    print(f"  Total unique text_id references: {total_refs}")

    # ---- Step 4: Build usage index ----
    print("\nBuilding text usage index...")
    usage_index = build_text_usage_index(table_refs)
    referenced_ids = set(usage_index.keys())
    print(f"  Text IDs referenced by game tables: {len(referenced_ids)}")

    # Count unreferenced texts
    all_non_empty_ids = {e["text_id"] for e in text_entries}
    unreferenced = all_non_empty_ids - referenced_ids
    print(f"  Unreferenced text IDs: {len(unreferenced)}")

    # ---- Step 5: Annotate entries with usage info ----
    print("\nAnnotating text entries with usage info...")
    for entry in text_entries:
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
    for entry in text_entries:
        for cat in entry.get("categories", []):
            category_summary[cat] += 1

    # ---- Step 7: Export static relationships ----
    print("\nBuilding static text relationships...")
    static_relationships = build_static_relationships(tables, ref_records)
    print(
        "  Static relations:"
        f" npc={static_relationships['npc_descriptions']['count']},"
        f" item={static_relationships['item_descriptions']['count']},"
        f" choice={static_relationships['choice_sets']['count']},"
        f" quest={static_relationships['quest_texts']['count']}"
    )

    # ---- Step 8: Export event dialogue ----
    print("\nBuilding event dialogue export...")
    event_dialogues = build_event_dialogues(
        assets_dir,
        tables,
        ref_records,
        static_relationships["choice_sets"],
    )
    print(
        "  Event export:"
        f" events={event_dialogues['event_count']},"
        f" dialogue={event_dialogues['kind_counts'].get('dialogue', 0)},"
        f" narration={event_dialogues['kind_counts'].get('narration', 0)},"
        f" choice={event_dialogues['kind_counts'].get('choice', 0)},"
        f" overlay={event_dialogues['kind_counts'].get('overlay_text', 0)}"
    )

    # ---- Step 9: Write outputs ----
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    consolidated_path = OUTPUT_DIR / "consolidated_texts.json"
    static_path = OUTPUT_DIR / "static_relationships.json"
    event_path = OUTPUT_DIR / "event_dialogues.json"

    consolidated_output = {
        "description": "Consolidated simplified Chinese text resources from Inotia4 game data",
        "source_file": f"{TARGET_MEMORYTEXT_STEM}.dat.jpg",
        "language": TARGET_LANGUAGE,
        "total_text_ids": len(ref_records),
        "non_empty_entries": len(text_entries),
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
        "entries": text_entries,
    }

    consolidated_path.write_text(
        json.dumps(consolidated_output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    static_path.write_text(
        json.dumps(static_relationships, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    event_path.write_text(
        json.dumps(event_dialogues, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nOutputs written to:")
    print(f"  {consolidated_path} ({consolidated_path.stat().st_size:,} bytes)")
    print(f"  {static_path} ({static_path.stat().st_size:,} bytes)")
    print(f"  {event_path} ({event_path.stat().st_size:,} bytes)")

    # ---- Summary ----
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Language:               {TARGET_LANGUAGE}")
    print(f"  Total text IDs:         {len(ref_records):,}")
    print(f"  Non-empty entries:      {len(text_entries):,}")
    print(f"  Referenced by tables:   {len(referenced_ids):,}")
    print(f"  Unreferenced:           {len(unreferenced):,}")
    print(f"  Categories found:       {len(category_summary)}")
    print(
        "  Static relations:      "
        f" npc={static_relationships['npc_descriptions']['count']},"
        f" item={static_relationships['item_descriptions']['count']},"
        f" choice={static_relationships['choice_sets']['count']},"
        f" quest={static_relationships['quest_texts']['count']}"
    )
    print(
        "  Event lines:           "
        f" dialogue={event_dialogues['kind_counts'].get('dialogue', 0)},"
        f" narration={event_dialogues['kind_counts'].get('narration', 0)},"
        f" choice={event_dialogues['kind_counts'].get('choice', 0)},"
        f" overlay={event_dialogues['kind_counts'].get('overlay_text', 0)}"
    )
    print(f"\n  Category breakdown:")
    for cat, count in sorted(category_summary.items(), key=lambda x: -x[1]):
        print(f"    {cat:30s} {count:5d} text IDs")


if __name__ == "__main__":
    main()
