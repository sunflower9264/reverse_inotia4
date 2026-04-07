#!/usr/bin/env python3
from __future__ import annotations

import json
import lzma
import re
import shutil
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
APK_INPUT_DIR = ROOT / "apk"
WORKDIR_DIR = ROOT / "workdir"
OUTPUT_DIR = ROOT / "web_viewer" / "public"
WORLDMAP_REGIONS_PATH = ROOT / "data" / "worldmap_regions.json"
RESOURCE_RELATIVE_DIR = Path("assets") / "common" / "game_res"
MEMORYTEXT_RESOURCE_NAME = "memorytext_zhhans"

MAPCOLORBASE_INDEX = 57
MAPINFOBASE_INDEX = 58
MAP_COUNT = 416
TILE_SIZE = 16
TRANSPARENT_565 = 0x2484
TILE_ATLAS_WIDTH = 2048
FEATURE_ATLAS_WIDTH = 2048


@dataclass(frozen=True)
class TileSprite:
    tile_id: int
    sprite_type: int
    width: int
    height: int
    x_offset: int
    y_offset: int
    palette_id: int | None
    pixels: bytes
    embedded_palette_colors: tuple[int, ...] | None


@dataclass(frozen=True)
class FeatureSprite:
    feature_id: int
    sprite_type: int
    width: int
    height: int
    x_offset: int
    y_offset: int
    palette_id: int
    pixels: bytes


@dataclass(frozen=True)
class PaletteRecord:
    entry_index: int
    palette_id: int
    colors_565: tuple[int, ...]


@dataclass(frozen=True)
class AtlasPlacement:
    sprite_id: int
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class WorldmapRegionSource:
    sprite_index: int
    name: str
    map_ids: tuple[int, ...]


class BinaryCursor:
    def __init__(self, data: bytes, offset: int = 0) -> None:
        self.data = data
        self.offset = offset

    def read_u8(self) -> int:
        if self.offset >= len(self.data):
            raise ValueError("read_u8 beyond end of buffer")
        value = self.data[self.offset]
        self.offset += 1
        return value

    def read_u16(self) -> int:
        if self.offset + 2 > len(self.data):
            raise ValueError("read_u16 beyond end of buffer")
        value = struct.unpack_from("<H", self.data, self.offset)[0]
        self.offset += 2
        return value


def build_asset_id(relative_path: Path) -> str:
    return re.sub(r"[^a-z0-9]+", "-", relative_path.as_posix().lower()).strip("-")


def humanize_asset_label(name: str) -> str:
    label = re.sub(r"[_-]+", " ", name)
    label = re.sub(r"(?<=[A-Za-z])(\d+)$", r" \1", label)
    return re.sub(r"\s+", " ", label).strip()


def discover_single_apk() -> Path:
    APK_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    apk_paths = sorted(APK_INPUT_DIR.glob("*.apk"))
    if not apk_paths:
        raise FileNotFoundError(
            f"expected exactly one APK in {APK_INPUT_DIR}, found none; place your APK there and rerun"
        )
    if len(apk_paths) > 1:
        joined = ", ".join(path.name for path in apk_paths)
        raise ValueError(f"expected exactly one APK in {APK_INPUT_DIR}, found {len(apk_paths)}: {joined}")
    return apk_paths[0]


def prepare_assets_dir(apk_path: Path) -> Path:
    if WORKDIR_DIR.exists():
        shutil.rmtree(WORKDIR_DIR)

    extract_root = WORKDIR_DIR / apk_path.stem
    extract_root.mkdir(parents=True, exist_ok=True)

    print(f"Extracting {apk_path.name} -> {extract_root}...")
    with zipfile.ZipFile(apk_path) as archive:
        archive.extractall(extract_root)

    assets_dir = extract_root / RESOURCE_RELATIVE_DIR
    if not assets_dir.is_dir():
        raise FileNotFoundError(f"missing resource directory after extraction: {assets_dir}")
    return assets_dir


def prepare_output_dir() -> None:
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    (OUTPUT_DIR / "maps").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "tiles").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "features").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "texts").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "worldmap").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "debug" / "previews").mkdir(parents=True, exist_ok=True)


def props_to_lclppb(prop: int) -> tuple[int, int, int] | None:
    if prop >= 225:
        return None
    pb = prop // 45
    rem = prop % 45
    lp = rem // 9
    lc = rem % 9
    return lc, lp, pb


def decode_raw_with_limit(comp: bytes, filters: list[dict[str, Any]], out_size: int) -> bytes:
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
    props = props_to_lclppb(data[2])
    if props is None:
        raise ValueError(f"invalid outer LZMA property byte: {data[2]:#x}")
    lc, lp, pb = props
    dict_size = int.from_bytes(data[3:7], "little")
    out_size = int.from_bytes(data[7:11], "little")
    decoded = decode_raw_with_limit(
        data[15:],
        [
            {
                "id": lzma.FILTER_LZMA1,
                "dict_size": max(dict_size, 4096),
                "lc": lc,
                "lp": lp,
                "pb": pb,
            }
        ],
        out_size,
    )
    if len(decoded) != out_size:
        raise ValueError(f"short outer decode: {len(decoded)} != {out_size}")
    return decoded


def decode_inner_segment(segment: bytes) -> bytes:
    if len(segment) < 15:
        return segment
    for prop_off, dict_off, size_off, payload_off in ((1, 2, 6, 14), (2, 3, 7, 15)):
        if len(segment) <= payload_off:
            continue
        props = props_to_lclppb(segment[prop_off])
        if props is None:
            continue
        lc, lp, pb = props
        dict_size = int.from_bytes(segment[dict_off : dict_off + 4], "little")
        out_size = int.from_bytes(segment[size_off : size_off + 4], "little")
        try:
            decoded = decode_raw_with_limit(
                segment[payload_off:],
                [
                    {
                        "id": lzma.FILTER_LZMA1,
                        "dict_size": max(dict_size, 4096),
                        "lc": lc,
                        "lp": lp,
                        "pb": pb,
                    }
                ],
                out_size,
            )
        except lzma.LZMAError:
            continue
        if len(decoded) == out_size:
            return decoded
    return segment


def detect_count_based_snasys(blob: bytes) -> tuple[int, list[int]]:
    if len(blob) < 24:
        raise ValueError("blob is too small for count-based SNASYS")
    entry_count = struct.unpack_from("<I", blob, 0)[0]
    if not (0 < entry_count < 10000):
        raise ValueError("invalid SNASYS entry count")
    for table_base in (18, 19, 20):
        if table_base + (entry_count + 1) * 3 > len(blob):
            continue
        values = []
        previous = -1
        valid = True
        for index in range(entry_count + 1):
            value = int.from_bytes(blob[table_base + index * 3 : table_base + index * 3 + 3], "little")
            masked = value & 0x7FFFFF
            if masked < previous or masked > len(blob):
                valid = False
                break
            values.append(value)
            previous = masked
        if valid:
            return table_base, values
    raise ValueError("failed to locate a monotonic SNASYS offset table")


def decode_snasys_entries(blob: bytes) -> list[bytes]:
    _, raw_entries = detect_count_based_snasys(blob)
    decoded: list[bytes] = []
    for index in range(len(raw_entries) - 1):
        cur = raw_entries[index]
        nxt = raw_entries[index + 1]
        start = cur & 0x7FFFFF
        end = nxt & 0x7FFFFF
        segment = blob[start:end]
        decoded.append(decode_inner_segment(segment) if cur >> 23 else segment)
    return decoded


def decode_direct_snasys_entries(blob: bytes, *, table_offset: int = 0x12) -> list[bytes]:
    if len(blob) < table_offset:
        raise ValueError("direct SNASYS blob too small")
    entry_count = int.from_bytes(blob[:4], "little")
    if entry_count <= 0 or table_offset + entry_count * 3 > len(blob):
        raise ValueError(f"invalid direct SNASYS entry count: {entry_count}")

    decoded: list[bytes] = []
    for index in range(entry_count):
        offset_pos = table_offset + index * 3
        current = int.from_bytes(blob[offset_pos : offset_pos + 3], "little")
        start = current & 0x7FFFFF
        if index + 1 < entry_count:
            next_offset = int.from_bytes(blob[offset_pos + 3 : offset_pos + 6], "little")
            end = next_offset & 0x7FFFFF
        else:
            end = len(blob)
        if start > end or end > len(blob):
            raise ValueError(f"invalid direct SNASYS range at entry {index}: {start:#x}..{end:#x}")
        segment = blob[start:end]
        decoded.append(decode_inner_segment(segment) if current >> 23 else segment)
    return decoded


def parse_excel_tables(blob: bytes) -> list[bytes]:
    if len(blob) < 5:
        raise ValueError("excel blob too small")
    table_count = int.from_bytes(blob[:2], "little")
    header_size = 2 + (table_count + 1) * 3
    if header_size > len(blob):
        raise ValueError("excel header extends beyond blob size")
    offsets = [
        int.from_bytes(blob[2 + index * 3 : 5 + index * 3], "little")
        for index in range(table_count + 1)
    ]
    if offsets[0] != 0:
        raise ValueError("excel table offsets do not start at zero")
    return [
        blob[header_size + offsets[index] : header_size + offsets[index + 1]]
        for index in range(table_count)
    ]


def parse_table_records(table_blob: bytes) -> tuple[int, int, bytes]:
    if len(table_blob) < 6:
        raise ValueError("table blob is too small")
    record_count = struct.unpack_from("<I", table_blob, 0)[0]
    record_size = struct.unpack_from("<H", table_blob, 4)[0]
    return record_count, record_size, table_blob[6:]


def rgb565_to_rgb(color: int) -> tuple[int, int, int]:
    r = ((color >> 11) & 0x1F) * 255 // 31
    g = ((color >> 5) & 0x3F) * 255 // 63
    b = (color & 0x1F) * 255 // 31
    return r, g, b


def rgba_for_indexed_color(
    color: int,
    index: int,
    *,
    transparent_index: int | None,
    transparent_color: int | None,
) -> tuple[int, int, int, int]:
    r, g, b = rgb565_to_rgb(color)
    if transparent_index is not None and index == transparent_index:
        return r, g, b, 0
    if transparent_color is not None and color == transparent_color:
        return r, g, b, 0
    return r, g, b, 255


def mirrored_anchor_left(anchor_x: int, width: int) -> int:
    return width - 1 - anchor_x


def tile_transparency_rules(sprite_type: int) -> tuple[int | None, int | None]:
    if sprite_type in (0x01, 0x03):
        return None, None
    if sprite_type == 0x81:
        return None, TRANSPARENT_565
    if sprite_type == 0x83:
        return 0, None
    raise ValueError(f"unsupported sprite type: {sprite_type:#x}")


def tile_draw_left(sprite: TileSprite, cell_x: int, flip: bool) -> int:
    if flip:
        return cell_x + TILE_SIZE - sprite.width + sprite.x_offset
    return cell_x - sprite.x_offset


def tile_draw_top(sprite: TileSprite, cell_y: int) -> int:
    return cell_y - sprite.y_offset


def parse_mapinfo_records(game_tables: list[bytes]) -> list[bytes]:
    table_blob = game_tables[MAPINFOBASE_INDEX]
    record_count, record_size, body = parse_table_records(table_blob)
    if record_count != MAP_COUNT:
        raise ValueError(f"unexpected MAPINFOBASE count: {record_count}")
    return [body[index * record_size : (index + 1) * record_size] for index in range(record_count)]


def parse_mapcolor_records(game_tables: list[bytes]) -> list[bytes]:
    table_blob = game_tables[MAPCOLORBASE_INDEX]
    record_count, record_size, body = parse_table_records(table_blob)
    return [body[index * record_size : (index + 1) * record_size] for index in range(record_count)]


def decode_packed_tile_pixels(width: int, height: int, bpp: int, payload: bytes) -> bytes:
    row_bytes = (width * bpp + 7) // 8
    expected = row_bytes * height
    if len(payload) != expected:
        raise ValueError(f"packed tile payload length mismatch: {len(payload)} != {expected}")

    pixels = bytearray()
    mask = (1 << bpp) - 1
    for row in range(height):
        row_data = payload[row * row_bytes : (row + 1) * row_bytes]
        bit_cursor = 0
        for _ in range(width):
            byte_index = bit_cursor // 8
            shift = 8 - bpp - (bit_cursor % 8)
            pixels.append((row_data[byte_index] >> shift) & mask)
            bit_cursor += bpp
    return bytes(pixels)


def decode_packed_pixels_contiguous(pixel_count: int, bpp: int, payload: bytes) -> bytes:
    expected = (pixel_count * bpp + 7) // 8
    if len(payload) != expected:
        raise ValueError(f"packed payload length mismatch: {len(payload)} != {expected}")

    pixels = bytearray()
    mask = (1 << bpp) - 1
    bit_cursor = 0
    for _ in range(pixel_count):
        byte_index = bit_cursor // 8
        shift = 8 - bpp - (bit_cursor % 8)
        pixels.append((payload[byte_index] >> shift) & mask)
        bit_cursor += bpp
    return bytes(pixels)


def indexed_palette_bits(palette_count: int) -> int:
    if palette_count <= 2:
        return 1
    if palette_count <= 4:
        return 2
    if palette_count <= 16:
        return 4
    return 8


def decode_indexed_sprite_payload(width: int, height: int, palette_count: int, payload: bytes) -> bytes | None:
    pixel_count = width * height
    if len(payload) == pixel_count:
        return payload

    bpp = indexed_palette_bits(palette_count)
    row_bytes = (width * bpp + 7) // 8
    if len(payload) == row_bytes * height:
        return decode_packed_tile_pixels(width, height, bpp, payload)

    packed_len = (pixel_count * bpp + 7) // 8
    if len(payload) == packed_len:
        return decode_packed_pixels_contiguous(pixel_count, bpp, payload)

    return None


def parse_tile_sprite(tile_id: int, blob: bytes) -> TileSprite | None:
    if len(blob) < 10 or blob[0] not in (0x01, 0x03, 0x81, 0x83):
        return None

    width = int.from_bytes(blob[1:3], "little")
    height = int.from_bytes(blob[3:5], "little")
    if width <= 0 or height <= 0:
        return None

    x_offset = struct.unpack_from("<h", blob, 5)[0]
    y_offset = struct.unpack_from("<h", blob, 7)[0]

    if blob[0] in (0x03, 0x83):
        pixel_count = width * height
        if len(blob) != 10 + pixel_count:
            return None
        return TileSprite(
            tile_id=tile_id,
            sprite_type=blob[0],
            width=width,
            height=height,
            x_offset=x_offset,
            y_offset=y_offset,
            palette_id=blob[9],
            pixels=blob[10 : 10 + pixel_count],
            embedded_palette_colors=None,
        )

    palette_count = blob[9] + 1
    if palette_count <= 0:
        return None
    bpp = max(1, (palette_count - 1).bit_length())
    palette_end = 10 + palette_count * 2
    if len(blob) < palette_end:
        return None
    palette_colors = tuple(
        struct.unpack_from("<H", blob, 10 + index * 2)[0]
        for index in range(palette_count)
    )
    payload = blob[palette_end:]
    pixels = decode_indexed_sprite_payload(width, height, palette_count, payload)
    if pixels is None:
        return None
    return TileSprite(
        tile_id=tile_id,
        sprite_type=blob[0],
        width=width,
        height=height,
        x_offset=x_offset,
        y_offset=y_offset,
        palette_id=None,
        pixels=pixels,
        embedded_palette_colors=palette_colors,
    )


def load_tile_sprites(entries: list[bytes]) -> dict[int, TileSprite]:
    sprites: dict[int, TileSprite] = {}
    for index, blob in enumerate(entries):
        sprite = parse_tile_sprite(index, blob)
        if sprite is not None:
            sprites[index] = sprite
    return sprites


def load_tile_palette_records(entries: list[bytes]) -> dict[int, PaletteRecord]:
    records: dict[int, PaletteRecord] = {}
    for index in range(1947, min(1983, len(entries))):
        blob = entries[index]
        if len(blob) < 3:
            continue
        colors = tuple(
            struct.unpack_from("<H", blob, offset)[0]
            for offset in range(1, len(blob), 2)
            if offset + 2 <= len(blob)
        )
        records[index] = PaletteRecord(index, blob[0], colors)
    return records


def load_feature_sprites(entries: list[bytes]) -> dict[int, FeatureSprite]:
    sprites: dict[int, FeatureSprite] = {}
    for index, blob in enumerate(entries):
        if len(blob) < 10 or blob[0] != 0x83:
            continue
        width = int.from_bytes(blob[1:3], "little")
        height = int.from_bytes(blob[3:5], "little")
        if width <= 0 or height <= 0 or 10 + width * height != len(blob):
            continue
        sprites[index] = FeatureSprite(
            feature_id=index,
            sprite_type=blob[0],
            width=width,
            height=height,
            x_offset=struct.unpack_from("<h", blob, 5)[0],
            y_offset=struct.unpack_from("<h", blob, 7)[0],
            palette_id=blob[9],
            pixels=blob[10:],
        )
    return sprites


def load_feature_groups(entries: list[bytes], max_feature_id: int) -> tuple[list[list[int]], dict[int, int]]:
    groups: list[list[int]] = []
    lookup: dict[int, int] = {}
    for blob in entries:
        if len(blob) < 2:
            continue
        count = int.from_bytes(blob[:2], "little")
        if count <= 0 or 2 + count * 2 != len(blob):
            continue
        values = [int.from_bytes(blob[2 + index * 2 : 4 + index * 2], "little") for index in range(count)]
        if any(value > max_feature_id for value in values):
            continue
        groups.append(values)
    if len(groups) < 9:
        raise ValueError(f"expected at least 9 feature palette groups, found {len(groups)}")
    groups = groups[:9]
    for group_id, feature_ids in enumerate(groups):
        for feature_id in feature_ids:
            lookup[feature_id] = group_id
    return groups, lookup


def load_feature_palette_records(entries: list[bytes], palette_ids: set[int]) -> dict[int, PaletteRecord]:
    records: dict[int, PaletteRecord] = {}
    for index, blob in enumerate(entries):
        if len(blob) < 3 or blob[0] not in palette_ids or (len(blob) - 1) % 2:
            continue
        colors = tuple(
            struct.unpack_from("<H", blob, offset)[0]
            for offset in range(1, len(blob), 2)
            if offset + 2 <= len(blob)
        )
        records[index] = PaletteRecord(index, blob[0], colors)
    return records


def build_map_palette_sets(
    mapcolor_records: list[bytes],
    tile_palette_records: dict[int, PaletteRecord],
    feature_palette_records: dict[int, PaletteRecord],
) -> list[dict[str, Any]]:
    palette_sets: list[dict[str, Any]] = []
    for set_id, record in enumerate(mapcolor_records):
        tile_entry_indices = list(struct.unpack_from("<8H", record, 0))
        feature_entry_indices = list(struct.unpack_from("<9H", record, 16))
        tile_palettes = [tile_palette_records[index] for index in tile_entry_indices if index in tile_palette_records]
        feature_palettes = [feature_palette_records[index] for index in feature_entry_indices if index in feature_palette_records]
        palette_sets.append(
            {
                "set_id": set_id,
                "tile_entry_indices": tile_entry_indices,
                "feature_entry_indices": feature_entry_indices,
                "tile_palettes": tile_palettes,
                "feature_palettes": feature_palettes,
                "tile_palette_map": {palette.palette_id: palette for palette in tile_palettes},
                "feature_palette_map": {palette.palette_id: palette for palette in feature_palettes},
            }
        )
    return palette_sets


def make_indexed_rgba_from_colors(
    width: int,
    height: int,
    pixels: bytes,
    palette_colors: tuple[int, ...],
    *,
    transparent_index: int | None,
    transparent_color: int | None,
) -> Image.Image:
    rgba = bytearray()
    for pixel in pixels:
        color = palette_colors[pixel] if pixel < len(palette_colors) else 0
        rgba.extend(
            rgba_for_indexed_color(
                color,
                pixel,
                transparent_index=transparent_index,
                transparent_color=transparent_color,
            )
        )
    return Image.frombytes("RGBA", (width, height), bytes(rgba))


def make_indexed_rgba(
    width: int,
    height: int,
    pixels: bytes,
    palette: PaletteRecord,
    *,
    transparent_index: int | None,
    transparent_color: int | None,
) -> Image.Image:
    return make_indexed_rgba_from_colors(
        width,
        height,
        pixels,
        palette.colors_565,
        transparent_index=transparent_index,
        transparent_color=transparent_color,
    )


def pack_sprite_atlas(items: list[tuple[int, int, int]], atlas_width: int) -> tuple[list[AtlasPlacement], int]:
    placements: list[AtlasPlacement] = []
    x = 0
    y = 0
    row_height = 0
    ordered = sorted(items, key=lambda item: (-item[2], item[0]))
    for sprite_id, width, height in ordered:
        if x and x + width > atlas_width:
            x = 0
            y += row_height + 1
            row_height = 0
        placements.append(AtlasPlacement(sprite_id, x, y, width, height))
        x += width + 1
        row_height = max(row_height, height)
    return placements, y + row_height


def pack_feature_atlas(sprites: dict[int, FeatureSprite], atlas_width: int) -> tuple[list[AtlasPlacement], int]:
    return pack_sprite_atlas(
        [(sprite.feature_id, sprite.width, sprite.height) for sprite in sprites.values()],
        atlas_width,
    )


def build_group_lists(feature_group_lookup: dict[int, int]) -> list[list[int]]:
    groups: list[list[int]] = [[] for _ in range(9)]
    for feature_id, group_id in sorted(feature_group_lookup.items()):
        groups[group_id].append(feature_id)
    return groups


def render_tile_atlases(
    tiles_dir: Path,
    tiles: dict[int, TileSprite],
    palette_sets: list[dict[str, Any]],
) -> None:
    atlas_dir = tiles_dir / "atlas"
    atlas_dir.mkdir(parents=True, exist_ok=True)
    placements, atlas_height = pack_sprite_atlas(
        [(sprite.tile_id, sprite.width, sprite.height) for sprite in tiles.values()],
        TILE_ATLAS_WIDTH,
    )
    placement_map = {placement.sprite_id: placement for placement in placements}

    for palette_set in palette_sets:
        set_id = palette_set["set_id"]
        image = Image.new("RGBA", (TILE_ATLAS_WIDTH, atlas_height), (0, 0, 0, 0))
        for tile_id, sprite in tiles.items():
            transparent_index, transparent_color = tile_transparency_rules(sprite.sprite_type)
            if sprite.embedded_palette_colors is not None:
                tile_image = make_indexed_rgba_from_colors(
                    sprite.width,
                    sprite.height,
                    sprite.pixels,
                    sprite.embedded_palette_colors,
                    transparent_index=transparent_index,
                    transparent_color=transparent_color,
                )
            else:
                palette = palette_set["tile_palette_map"].get(sprite.palette_id)
                if palette is None:
                    tile_image = Image.new("RGBA", (sprite.width, sprite.height), (255, 0, 255, 255))
                else:
                    tile_image = make_indexed_rgba(
                        sprite.width,
                        sprite.height,
                        sprite.pixels,
                        palette,
                        transparent_index=transparent_index,
                        transparent_color=transparent_color,
                    )
            placement = placement_map[tile_id]
            image.paste(tile_image, (placement.x, placement.y), tile_image)
        image.save(atlas_dir / f"tile_palette_set_{set_id:02d}.png")

    manifest = {
        "tile_size": TILE_SIZE,
        "atlas_width": TILE_ATLAS_WIDTH,
        "atlas_height": atlas_height,
        "tile_count": len(tiles),
        "atlas_files": [f"atlas/tile_palette_set_{set_id:02d}.png" for set_id in range(len(palette_sets))],
        "tiles": [
            {
                "tile_id": tile_id,
                "palette_id": sprite.palette_id,
                "width": sprite.width,
                "height": sprite.height,
                "x_offset": sprite.x_offset,
                "y_offset": sprite.y_offset,
                "atlas_x": placement_map[tile_id].x,
                "atlas_y": placement_map[tile_id].y,
            }
            for tile_id, sprite in sorted(tiles.items())
        ],
    }
    (tiles_dir / "tileset_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def render_feature_atlases(
    features_dir: Path,
    sprites: dict[int, FeatureSprite],
    palette_sets: list[dict[str, Any]],
    feature_group_lookup: dict[int, int],
) -> None:
    atlas_dir = features_dir / "atlas"
    atlas_dir.mkdir(parents=True, exist_ok=True)
    placements, atlas_height = pack_feature_atlas(sprites, FEATURE_ATLAS_WIDTH)
    placement_map = {placement.sprite_id: placement for placement in placements}
    for palette_set in palette_sets:
        set_id = palette_set["set_id"]
        image = Image.new("RGBA", (FEATURE_ATLAS_WIDTH, atlas_height), (0, 0, 0, 0))
        for feature_id, sprite in sorted(sprites.items()):
            group_id = feature_group_lookup.get(feature_id)
            palette = None
            if group_id is not None and group_id < len(palette_set["feature_palettes"]):
                palette = palette_set["feature_palettes"][group_id]
            if palette is None:
                palette = palette_set["feature_palette_map"].get(sprite.palette_id)
            if palette is None:
                sprite_image = Image.new("RGBA", (sprite.width, sprite.height), (255, 0, 255, 192))
            else:
                transparent_index, transparent_color = tile_transparency_rules(sprite.sprite_type)
                sprite_image = make_indexed_rgba(
                    sprite.width,
                    sprite.height,
                    sprite.pixels,
                    palette,
                    transparent_index=transparent_index,
                    transparent_color=transparent_color,
                )
            placement = placement_map[feature_id]
            image.paste(sprite_image, (placement.x, placement.y), sprite_image)
        image.save(atlas_dir / f"feature_palette_set_{set_id:02d}.png")

    manifest = {
        "atlas_width": FEATURE_ATLAS_WIDTH,
        "atlas_height": atlas_height,
        "atlas_files": [f"atlas/feature_palette_set_{set_id:02d}.png" for set_id in range(len(palette_sets))],
        "feature_count": len(sprites),
        "features": [
            {
                "feature_id": sprite.feature_id,
                "group_id": feature_group_lookup.get(sprite.feature_id),
                "palette_id": sprite.palette_id,
                "width": sprite.width,
                "height": sprite.height,
                "x_offset": sprite.x_offset,
                "y_offset": sprite.y_offset,
                "atlas_x": placement_map[sprite.feature_id].x,
                "atlas_y": placement_map[sprite.feature_id].y,
            }
            for sprite in sorted(sprites.values(), key=lambda item: item.feature_id)
        ],
        "groups": [
            {"group_id": group_id, "feature_ids": feature_ids}
            for group_id, feature_ids in enumerate(build_group_lists(feature_group_lookup))
        ],
    }
    (features_dir / "feature_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_base_cell(byte0: int, byte1: int) -> tuple[int, int]:
    tile_id = byte1 | ((byte0 & 0x07) << 8)
    base_flags = byte0 >> 4
    return tile_id, base_flags


def layer_candidates(header_flags: int) -> list[int]:
    if header_flags & 0x0C:
        return [1, 2, 3, 4]
    return [0, 1, 2, 3, 4]


def parse_map_blob(map_id: int, blob: bytes, palette_set_id: int) -> dict[str, Any]:
    if len(blob) < 4:
        raise ValueError(f"map {map_id} is too small")
    width = blob[2]
    height = blob[3]
    cell_count = width * height
    base_start = 4
    base_end = base_start + cell_count * 2
    if base_end > len(blob):
        raise ValueError(f"map {map_id} base data exceeds blob size")

    base_cells = [-1] * cell_count
    base_flags = [0] * cell_count
    for index in range(cell_count):
        byte0 = blob[base_start + index * 2]
        byte1 = blob[base_start + index * 2 + 1]
        tile_id, flags = parse_base_cell(byte0, byte1)
        base_cells[index] = tile_id
        base_flags[index] = flags

    layer_slots = [[-1, -1, -1, -1, -1] for _ in range(cell_count)]
    shadow1 = [-1] * cell_count
    shadow2 = [-1] * cell_count
    top = [-1] * cell_count
    static_features_raw: list[dict[str, Any]] = []
    ignored_records: list[dict[str, Any]] = []

    cursor = BinaryCursor(blob, base_end)
    total_feature_count_offset = cursor.offset
    total_feature_count = cursor.read_u16()
    feature_layer_counts_offset = cursor.offset
    feature_layer_counts = [cursor.read_u16() for _ in range(4)]
    entry_group_count_offset = cursor.offset
    entry_group_count = cursor.read_u8()
    entry_records_start = cursor.offset

    for _ in range(entry_group_count):
        group_header_offset = cursor.offset
        header = cursor.read_u8()
        repeat_count = cursor.read_u16()
        if repeat_count == 0:
            continue
        section = header >> 4
        slot_bias = 1 if header & 0x0C else 0
        for _ in range(repeat_count):
            record_offset = cursor.offset
            map_x = cursor.read_u8()
            map_y = cursor.read_u8()
            type_and_flags = cursor.read_u8()
            low_byte = cursor.read_u8()
            record_type = type_and_flags >> 4
            flip = bool(type_and_flags & 0x08)
            tile_or_feature_id = low_byte | ((type_and_flags & 0x07) << 8)
            if map_x >= width or map_y >= height:
                ignored_records.append(
                    {
                        "offset": record_offset,
                        "type": record_type,
                        "section": section,
                        "x": map_x,
                        "y": map_y,
                        "id": tile_or_feature_id,
                    }
                )
                continue

            cell_index = map_y * width + map_x
            packed_value = tile_or_feature_id | (0x800 if flip else 0)

            if record_type == 0:
                if section == 0:
                    for candidate in layer_candidates(header):
                        if 0 <= candidate < 5 and layer_slots[cell_index][candidate] == -1:
                            layer_slots[cell_index][candidate] = packed_value
                            break
                elif section == 1:
                    shadow1[cell_index] = packed_value
                elif section == 2:
                    shadow2[cell_index] = packed_value
                elif section == 3:
                    top[cell_index] = packed_value
            elif record_type == 4:
                static_features_raw.append(
                    {
                        "layer": section,
                        "x_tile": map_x,
                        "y_tile": map_y,
                        "x_px": map_x * TILE_SIZE + 8,
                        "y_px": map_y * TILE_SIZE + 8,
                        "feature_id": tile_or_feature_id,
                        "flip": flip,
                        "record_offset": record_offset,
                        "group_header_offset": group_header_offset,
                        "slot_bias": slot_bias,
                        "record_type": record_type,
                    }
                )
            else:
                ignored_records.append(
                    {
                        "offset": record_offset,
                        "type": record_type,
                        "section": section,
                        "x": map_x,
                        "y": map_y,
                        "id": tile_or_feature_id,
                        "flip": flip,
                    }
                )

    entry_records_end = cursor.offset
    link_count_offset = cursor.offset
    link_count = cursor.read_u8() if cursor.offset < len(blob) else 0
    link_records_start = cursor.offset
    link_records: list[dict[str, Any]] = []
    for _ in range(min(link_count, 0x28)):
        if cursor.offset + 6 > len(blob):
            break
        link_records.append(
            {
                "x": cursor.read_u8(),
                "y": cursor.read_u8(),
                "target_map": cursor.read_u8(),
                "target_link": cursor.read_u8(),
                "key": cursor.read_u8() | (cursor.read_u8() << 8),
            }
        )
    link_records_end = cursor.offset

    return {
        "map_id": map_id,
        "width": width,
        "height": height,
        "palette_set_id": palette_set_id,
        "raw_header_0": blob[0],
        "raw_header_1": blob[1],
        "base_cells": base_cells,
        "base_flags": base_flags,
        "layer_slots": layer_slots,
        "shadow1": shadow1,
        "shadow2": shadow2,
        "top": top,
        "total_feature_count": total_feature_count,
        "feature_layer_counts": feature_layer_counts,
        "static_features_raw": static_features_raw,
        "ignored_records": ignored_records,
        "link_records": link_records,
        "raw_tail_offsets": {
            "base_start": base_start,
            "base_end": base_end,
            "total_feature_count_offset": total_feature_count_offset,
            "feature_layer_counts_start": feature_layer_counts_offset,
            "feature_layer_counts_end": feature_layer_counts_offset + 8,
            "entry_group_count_offset": entry_group_count_offset,
            "entry_records_start": entry_records_start,
            "entry_records_end": entry_records_end,
            "link_count_offset": link_count_offset,
            "link_records_start": link_records_start,
            "link_records_end": link_records_end,
            "final_offset": cursor.offset,
            "total_size": len(blob),
        },
    }


def get_tile_image(
    cache: dict[tuple[int, int, bool], Image.Image],
    tile_images: dict[tuple[int, int], Image.Image],
    palette_set_id: int,
    tile_id: int,
    flip: bool,
) -> Image.Image | None:
    base = tile_images.get((palette_set_id, tile_id))
    if base is None:
        return None
    key = (palette_set_id, tile_id, flip)
    if key not in cache:
        cache[key] = ImageOps.mirror(base) if flip else base
    return cache[key]


def get_feature_image(
    cache: dict[tuple[int, int, bool], Image.Image],
    feature_images: dict[tuple[int, int], Image.Image],
    palette_set_id: int,
    feature_id: int,
    flip: bool,
) -> Image.Image | None:
    base = feature_images.get((palette_set_id, feature_id))
    if base is None:
        return None
    key = (palette_set_id, feature_id, flip)
    if key not in cache:
        cache[key] = ImageOps.mirror(base) if flip else base
    return cache[key]


def paste_tile_sprite(
    target: Image.Image,
    image: Image.Image,
    sprite: TileSprite,
    cell_x: int,
    cell_y: int,
    flip: bool,
) -> None:
    draw_x = tile_draw_left(sprite, cell_x, flip)
    draw_y = tile_draw_top(sprite, cell_y)
    target.paste(image, (draw_x, draw_y), image)


def render_map_passes(
    map_data: dict[str, Any],
    tile_images: dict[tuple[int, int], Image.Image],
    tile_sprites: dict[int, TileSprite],
    feature_images: dict[tuple[int, int], Image.Image],
    feature_sprites: dict[int, FeatureSprite],
) -> dict[str, Image.Image]:
    width = map_data["width"]
    height = map_data["height"]
    palette_set_id = map_data["palette_set_id"]
    canvas_size = (width * TILE_SIZE, height * TILE_SIZE)
    base_image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    layer_image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    shadow_image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    top_image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    feature_image = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    tile_flip_cache: dict[tuple[int, int, bool], Image.Image] = {}
    feature_flip_cache: dict[tuple[int, int, bool], Image.Image] = {}

    for y in range(height):
        for x in range(width):
            index = y * width + x
            px = x * TILE_SIZE
            py = y * TILE_SIZE

            tile_id = map_data["base_cells"][index]
            flags = map_data["base_flags"][index]
            if tile_id >= 0:
                flip = bool(flags & 0x04)
                image = get_tile_image(tile_flip_cache, tile_images, palette_set_id, tile_id, flip)
                sprite = tile_sprites.get(tile_id)
                if image is not None and sprite is not None:
                    paste_tile_sprite(base_image, image, sprite, px, py, flip)

            for packed in (map_data["shadow1"][index], map_data["shadow2"][index]):
                if packed >= 0:
                    tile_id = packed & 0x7FF
                    flip = bool(packed & 0x800)
                    image = get_tile_image(
                        tile_flip_cache,
                        tile_images,
                        palette_set_id,
                        tile_id,
                        flip,
                    )
                    sprite = tile_sprites.get(tile_id)
                    if image is not None and sprite is not None:
                        paste_tile_sprite(shadow_image, image, sprite, px, py, flip)

            for packed in map_data["layer_slots"][index]:
                if packed >= 0:
                    tile_id = packed & 0x7FF
                    flip = bool(packed & 0x800)
                    image = get_tile_image(
                        tile_flip_cache,
                        tile_images,
                        palette_set_id,
                        tile_id,
                        flip,
                    )
                    sprite = tile_sprites.get(tile_id)
                    if image is not None and sprite is not None:
                        paste_tile_sprite(layer_image, image, sprite, px, py, flip)

            packed = map_data["top"][index]
            if packed >= 0:
                tile_id = packed & 0x7FF
                flip = bool(packed & 0x800)
                image = get_tile_image(
                    tile_flip_cache,
                    tile_images,
                    palette_set_id,
                    tile_id,
                    flip,
                )
                sprite = tile_sprites.get(tile_id)
                if image is not None and sprite is not None:
                    paste_tile_sprite(top_image, image, sprite, px, py, flip)

    for item in sorted(
        map_data["static_features_raw"],
        key=lambda current: (current["layer"], current["y_px"], current["x_px"], current["feature_id"]),
    ):
        sprite = feature_sprites.get(item["feature_id"])
        if sprite is None:
            continue
        image = get_feature_image(
            feature_flip_cache,
            feature_images,
            palette_set_id,
            item["feature_id"],
            bool(item["flip"]),
        )
        if image is None:
            continue
        anchor_x = mirrored_anchor_left(sprite.x_offset, sprite.width) if item["flip"] else sprite.x_offset
        draw_x = item["x_px"] - anchor_x
        draw_y = item["y_px"] - sprite.y_offset
        feature_image.paste(image, (draw_x, draw_y), image)

    base_plus_layer = Image.alpha_composite(base_image, layer_image)
    base_plus_shadow = Image.alpha_composite(base_image, shadow_image)
    full_static = Image.alpha_composite(base_image, shadow_image)
    full_static = Image.alpha_composite(full_static, layer_image)
    full_static = Image.alpha_composite(full_static, feature_image)
    full_static = Image.alpha_composite(full_static, top_image)

    return {
        "base_only": base_image,
        "base_plus_layer": base_plus_layer,
        "base_plus_shadow": base_plus_shadow,
        "feature_only": feature_image,
        "top_only": top_image,
        "full_static": full_static,
    }


def build_tile_image_cache(
    tiles: dict[int, TileSprite],
    palette_sets: list[dict[str, Any]],
) -> dict[tuple[int, int], Image.Image]:
    cache: dict[tuple[int, int], Image.Image] = {}
    for palette_set in palette_sets:
        set_id = palette_set["set_id"]
        for tile_id, sprite in tiles.items():
            transparent_index, transparent_color = tile_transparency_rules(sprite.sprite_type)
            if sprite.embedded_palette_colors is not None:
                cache[(set_id, tile_id)] = make_indexed_rgba_from_colors(
                    sprite.width,
                    sprite.height,
                    sprite.pixels,
                    sprite.embedded_palette_colors,
                    transparent_index=transparent_index,
                    transparent_color=transparent_color,
                )
                continue
            palette = palette_set["tile_palette_map"].get(sprite.palette_id)
            if palette is None:
                continue
            cache[(set_id, tile_id)] = make_indexed_rgba(
                sprite.width,
                sprite.height,
                sprite.pixels,
                palette,
                transparent_index=transparent_index,
                transparent_color=transparent_color,
            )
    return cache


def collect_missing_tile_refs(map_data: dict[str, Any], tile_ids: set[int]) -> set[int]:
    missing: set[int] = set()
    missing.update(tile_id for tile_id in map_data["base_cells"] if tile_id >= 0 and tile_id not in tile_ids)
    missing.update((packed & 0x7FF) for packed in map_data["shadow1"] if packed >= 0 and (packed & 0x7FF) not in tile_ids)
    missing.update((packed & 0x7FF) for packed in map_data["shadow2"] if packed >= 0 and (packed & 0x7FF) not in tile_ids)
    missing.update((packed & 0x7FF) for packed in map_data["top"] if packed >= 0 and (packed & 0x7FF) not in tile_ids)
    for slots in map_data["layer_slots"]:
        missing.update((packed & 0x7FF) for packed in slots if packed >= 0 and (packed & 0x7FF) not in tile_ids)
    return missing


def build_feature_image_cache(
    sprites: dict[int, FeatureSprite],
    palette_sets: list[dict[str, Any]],
    feature_group_lookup: dict[int, int],
) -> dict[tuple[int, int], Image.Image]:
    cache: dict[tuple[int, int], Image.Image] = {}
    for palette_set in palette_sets:
        set_id = palette_set["set_id"]
        for feature_id, sprite in sprites.items():
            group_id = feature_group_lookup.get(feature_id)
            palette = None
            if group_id is not None and group_id < len(palette_set["feature_palettes"]):
                palette = palette_set["feature_palettes"][group_id]
            if palette is None:
                palette = palette_set["feature_palette_map"].get(sprite.palette_id)
            if palette is None:
                continue
            transparent_index, transparent_color = tile_transparency_rules(sprite.sprite_type)
            cache[(set_id, feature_id)] = make_indexed_rgba(
                sprite.width,
                sprite.height,
                sprite.pixels,
                palette,
                transparent_index=transparent_index,
                transparent_color=transparent_color,
            )
    return cache


def write_preview(image: Image.Image, out_path: Path, max_side: int = 224) -> None:
    preview = image.copy()
    preview.thumbnail((max_side, max_side), Image.Resampling.NEAREST)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(out_path)


def load_worldmap_region_sources() -> list[WorldmapRegionSource]:
    payload = json.loads(WORLDMAP_REGIONS_PATH.read_text(encoding="utf-8"))
    regions = payload.get("regions")
    if not isinstance(regions, list):
        raise ValueError("worldmap_regions.json is missing a regions array")
    return [
        WorldmapRegionSource(
            sprite_index=int(item["sprite_index"]),
            name=str(item["name"]),
            map_ids=tuple(sorted(int(map_id) for map_id in item["map_ids"])),
        )
        for item in regions
    ]


def mapinfo_name_text_id(record: bytes) -> int:
    return struct.unpack_from("<H", record, 0)[0]


def parse_memorytext_blob(blob: bytes) -> list[str]:
    if len(blob) < 4:
        raise ValueError("memorytext blob is too small")

    record_count = struct.unpack_from("<I", blob, 0)[0]
    table_end = 4 + record_count * 3
    if table_end > len(blob):
        raise ValueError("memorytext offset table extends beyond blob size")

    offsets: list[int] = []
    previous = table_end
    for index in range(record_count):
        offset = int.from_bytes(blob[4 + index * 3 : 7 + index * 3], "little")
        if offset < table_end or offset > len(blob):
            raise ValueError(f"invalid memorytext offset at {index}: {offset}")
        if offset < previous:
            raise ValueError(f"memorytext offsets are not monotonic at {index}: {offset} < {previous}")
        previous = offset
        offsets.append(offset)

    records: list[str] = []
    for offset in offsets:
        end = blob.find(b"\x00", offset)
        if end == -1:
            end = len(blob)
        records.append(blob[offset:end].decode("utf-8"))
    return records


def load_memorytext_records(assets_dir: Path, resource_name: str = MEMORYTEXT_RESOURCE_NAME) -> list[str]:
    return parse_memorytext_blob(load_resource_blob(assets_dir, resource_name))


def build_memorytext_dataset(texts_dir: Path, records: list[str]) -> dict[str, Any]:
    texts_dir.mkdir(parents=True, exist_ok=True)
    non_empty_entries = [
        {
            "text_id": text_id,
            "text": text,
            "has_markup": ("$" in text or "&" in text),
        }
        for text_id, text in enumerate(records)
        if text
    ]
    manifest = {
        "language": "zh-Hans",
        "resource_name": f"{MEMORYTEXT_RESOURCE_NAME}.dat.jpg",
        "record_count": len(records),
        "non_empty_count": len(non_empty_entries),
        "markup_count": sum(1 for entry in non_empty_entries if entry["has_markup"]),
        "entries": non_empty_entries,
    }
    (texts_dir / "memorytext_zhhans.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return manifest


def detect_passthrough_asset_format(source_path: Path) -> tuple[str, str] | None:
    with source_path.open("rb") as handle:
        header = handle.read(16)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", ".png"
    if header.startswith(b"OggS"):
        return "audio", ".ogg"
    return None


def build_passthrough_asset_dataset(extras_dir: Path, assets_dir: Path) -> dict[str, Any]:
    images_dir = extras_dir / "images"
    audio_dir = extras_dir / "audio"
    images_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    images: list[dict[str, Any]] = []
    audio_tracks: list[dict[str, Any]] = []

    for source_path in sorted(path for path in assets_dir.rglob("*") if path.is_file()):
        detected = detect_passthrough_asset_format(source_path)
        if detected is None:
            continue

        kind, suffix = detected
        relative_source = source_path.relative_to(assets_dir)
        source_stem = relative_source.stem
        base_name = Path(source_stem).stem
        asset_id = build_asset_id(relative_source)
        file_size = source_path.stat().st_size

        if kind == "image":
            destination_relative = Path("extras") / "images" / relative_source.parent / source_stem
            destination_path = OUTPUT_DIR / destination_relative
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, destination_path)
            with Image.open(source_path) as image:
                width, height = image.size
            images.append(
                {
                    "asset_id": asset_id,
                    "label": humanize_asset_label(base_name),
                    "source_name": relative_source.as_posix(),
                    "path": destination_relative.as_posix(),
                    "width": width,
                    "height": height,
                    "file_size": file_size,
                }
            )
            continue

        category = relative_source.parts[1].upper() if len(relative_source.parts) > 1 and relative_source.parts[0].upper() == "SOUND" else "MISC"
        destination_relative = Path("extras") / "audio" / category.lower() / f"{source_stem}{suffix}"
        destination_path = OUTPUT_DIR / destination_relative
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, destination_path)
        audio_tracks.append(
            {
                "asset_id": asset_id,
                "label": humanize_asset_label(base_name),
                "source_name": relative_source.as_posix(),
                "path": destination_relative.as_posix(),
                "category": category,
                "file_size": file_size,
            }
        )

    manifest = {
        "image_count": len(images),
        "audio_count": len(audio_tracks),
        "images": images,
        "audio": audio_tracks,
    }
    (extras_dir / "assets_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def decode_worldmap_entries(assets_dir: Path) -> list[bytes]:
    return decode_direct_snasys_entries((assets_dir / "i_worldmap.dat.jpg").read_bytes())


def build_embedded_sprite_image(sprite: TileSprite) -> Image.Image:
    if sprite.embedded_palette_colors is None:
        raise ValueError(f"worldmap sprite {sprite.tile_id} is missing an embedded palette")
    transparent_index, transparent_color = tile_transparency_rules(sprite.sprite_type)
    return make_indexed_rgba_from_colors(
        sprite.width,
        sprite.height,
        sprite.pixels,
        sprite.embedded_palette_colors,
        transparent_index=transparent_index,
        transparent_color=transparent_color,
    )


def render_worldmap_dataset(
    worldmap_dir: Path,
    sprites: dict[int, TileSprite],
    regions: list[WorldmapRegionSource],
) -> dict[str, Any]:
    placements: dict[int, dict[str, int]] = {}
    min_left = min(tile_draw_left(sprite, 0, False) for sprite in sprites.values())
    min_top = min(tile_draw_top(sprite, 0) for sprite in sprites.values())
    max_right = max(tile_draw_left(sprite, 0, False) + sprite.width for sprite in sprites.values())
    max_bottom = max(tile_draw_top(sprite, 0) + sprite.height for sprite in sprites.values())

    canvas = Image.new("RGBA", (max_right - min_left, max_bottom - min_top), (0, 0, 0, 0))
    for sprite_index, sprite in sorted(sprites.items()):
        image = build_embedded_sprite_image(sprite)
        left = tile_draw_left(sprite, 0, False)
        top = tile_draw_top(sprite, 0)
        placements[sprite_index] = {
            "x": left - min_left,
            "y": top - min_top,
            "width": sprite.width,
            "height": sprite.height,
        }
        canvas.paste(image, (left - min_left, top - min_top), image)

    worldmap_dir.mkdir(parents=True, exist_ok=True)
    image_path = worldmap_dir / "worldmap.png"
    canvas.save(image_path)

    manifest = {
        "width": canvas.width,
        "height": canvas.height,
        "image_path": "worldmap/worldmap.png",
        "sprite_count": len(sprites),
        "region_count": len(regions),
        "sprites": [
            {
                "sprite_index": sprite_index,
                "x_offset": sprite.x_offset,
                "y_offset": sprite.y_offset,
                **placements[sprite_index],
            }
            for sprite_index, sprite in sorted(sprites.items())
        ],
        "regions": [
            {
                "sprite_index": region.sprite_index,
                "name": region.name,
                "map_ids": list(region.map_ids),
                **placements[region.sprite_index],
                "center_x": placements[region.sprite_index]["x"] + placements[region.sprite_index]["width"] / 2,
                "center_y": placements[region.sprite_index]["y"] + placements[region.sprite_index]["height"] / 2,
            }
            for region in regions
            if region.sprite_index in placements
        ],
    }
    (worldmap_dir / "worldmap_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def load_resource_blob(assets_dir: Path, name: str) -> bytes:
    return decode_standard_outer((assets_dir / f"{name}.dat.jpg").read_bytes())


def main() -> None:
    apk_path = discover_single_apk()
    assets_dir = prepare_assets_dir(apk_path)
    prepare_output_dir()

    print("Loading game tables...")
    game_tables = parse_excel_tables(load_resource_blob(assets_dir, "game"))
    mapinfo_records = parse_mapinfo_records(game_tables)
    mapcolor_records = parse_mapcolor_records(game_tables)

    print("Decoding tile resources...")
    tile_entries = decode_snasys_entries(load_resource_blob(assets_dir, "i_tile"))
    tile_sprites = load_tile_sprites(tile_entries)
    tile_palette_records = load_tile_palette_records(tile_entries)

    print("Decoding feature resources...")
    feature_entries = decode_snasys_entries(load_resource_blob(assets_dir, "i_mapfeature"))
    feature_sprites = load_feature_sprites(feature_entries)
    feature_groups, feature_group_lookup = load_feature_groups(feature_entries, max(feature_sprites))
    feature_palette_ids = {sprite.palette_id for sprite in feature_sprites.values()}
    feature_palette_records = load_feature_palette_records(feature_entries, feature_palette_ids)

    print("Decoding memorytext resources...")
    memorytext_records = load_memorytext_records(assets_dir)

    print("Decoding worldmap resources...")
    worldmap_entries = decode_worldmap_entries(assets_dir)
    worldmap_sprites = {
        index: sprite
        for index, blob in enumerate(worldmap_entries)
        if (sprite := parse_tile_sprite(index, blob)) is not None
    }
    worldmap_region_sources = load_worldmap_region_sources()

    palette_sets = build_map_palette_sets(mapcolor_records, tile_palette_records, feature_palette_records)

    print("Rendering tile atlases...")
    render_tile_atlases(OUTPUT_DIR / "tiles", tile_sprites, palette_sets)
    print("Rendering feature atlases...")
    render_feature_atlases(OUTPUT_DIR / "features", feature_sprites, palette_sets, feature_group_lookup)
    print("Rendering memorytext dataset...")
    memorytext_manifest = build_memorytext_dataset(OUTPUT_DIR / "texts", memorytext_records)
    print("Rendering worldmap...")
    render_worldmap_dataset(OUTPUT_DIR / "worldmap", worldmap_sprites, worldmap_region_sources)
    print("Collecting passthrough image/audio assets...")
    passthrough_assets_manifest = build_passthrough_asset_dataset(OUTPUT_DIR / "extras", assets_dir)

    tile_images = build_tile_image_cache(tile_sprites, palette_sets)
    feature_images = build_feature_image_cache(feature_sprites, palette_sets, feature_group_lookup)

    manifest_maps: list[dict[str, Any]] = []

    for map_id in range(MAP_COUNT):
        print(f"Exporting map {map_id}...")
        mapinfo_record = mapinfo_records[map_id]
        palette_set_id = mapinfo_record[3]
        name_text_id = mapinfo_name_text_id(mapinfo_record)
        map_blob = load_resource_blob(assets_dir, f"m{map_id}")
        map_data = parse_map_blob(map_id, map_blob, palette_set_id)
        map_json = OUTPUT_DIR / "maps" / f"{map_id}.json"
        map_json.write_text(json.dumps(map_data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

        rendered = render_map_passes(map_data, tile_images, tile_sprites, feature_images, feature_sprites)
        write_preview(rendered["full_static"], OUTPUT_DIR / "debug" / "previews" / f"m{map_id}.png")

        manifest_maps.append(
            {
                "map_id": map_id,
                "name_text_id": name_text_id,
                "name": memorytext_records[name_text_id] if 0 <= name_text_id < len(memorytext_records) else "",
                "width": map_data["width"],
                "height": map_data["height"],
                "palette_set_id": palette_set_id,
                "has_static_features": bool(map_data["static_features_raw"]),
                "preview_path": f"debug/previews/m{map_id}.png",
                "raw_header_0": map_data["raw_header_0"],
                "raw_header_1": map_data["raw_header_1"],
            }
        )

    tile_ids = set(tile_sprites)
    missing_tile_refs: set[int] = set()
    for map_id in range(MAP_COUNT):
        map_json = OUTPUT_DIR / "maps" / f"{map_id}.json"
        map_data = json.loads(map_json.read_text(encoding="utf-8"))
        missing_tile_refs.update(collect_missing_tile_refs(map_data, tile_ids))
    if missing_tile_refs:
        sample_ids = ", ".join(str(tile_id) for tile_id in sorted(missing_tile_refs)[:20])
        raise ValueError(f"tile coverage check failed; missing {len(missing_tile_refs)} tile ids: {sample_ids}")

    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "map_count": MAP_COUNT,
                "tile_size": TILE_SIZE,
                "memorytext_manifest_path": "texts/memorytext_zhhans.json",
                "memorytext_record_count": memorytext_manifest["record_count"],
                "memorytext_non_empty_count": memorytext_manifest["non_empty_count"],
                "memorytext_markup_count": memorytext_manifest["markup_count"],
                "passthrough_assets_manifest_path": "extras/assets_manifest.json",
                "passthrough_image_count": passthrough_assets_manifest["image_count"],
                "passthrough_audio_count": passthrough_assets_manifest["audio_count"],
                "worldmap_manifest_path": "worldmap/worldmap_manifest.json",
                "maps": manifest_maps,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote dataset to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
