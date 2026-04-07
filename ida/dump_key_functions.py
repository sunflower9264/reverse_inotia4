"""
IDAPython batch exporter for key resource and decryption functions.

Usage:
    idat64.exe -A -S"dump_key_functions.py <output_dir>" libgame.so.i64
"""

from __future__ import annotations

import json
import os
import sys

import ida_auto
import ida_funcs
import ida_hexrays
import ida_kernwin
import ida_lines
import ida_name
import ida_segment
import ida_xref
import idautils
import idc


TARGETS = [
    "CS_knlGetResource",
    "CS_knlGetResourceID",
    "jGetFileDescriptorFromAsset",
    "GetDecryptionKey",
    "DecryptData",
    "DecryptFile",
    "LZMA_Decode",
    "LZMA_DecodeEx",
    "LZMA_Compression_Decode",
    "LzmaDecodeProperties",
    "_ZN14PackageDecoder10InitializeEPKc",
    "_ZN14PackageDecoder18InternalInitializeEP11MMappedFile",
    "_ZN14PackageDecoder26InternalInitializeVersion1EPh",
    "_ZN14PackageDecoder6DecodeEPhmS0_m",
    "_ZN15ResourceManager25InitializePackageVersion1EP14PackageDecoder",
]

TARGET_STRINGS = [
    "2SCR",
    "SCD2",
    "LzmaDecodeProperties",
    "game_res",
    "i_tile.dat",
    "getFileDescriptorFromAsset",
    "/sdcard/Android/data/%s/files/resources/common/%s/%s",
]


def resolve_output_dir() -> str:
    if len(idc.ARGV) >= 2:
        return os.path.abspath(idc.ARGV[1])
    return os.path.abspath("ida_dump")


def collect_strings() -> list[dict]:
    out = []
    for item in idautils.Strings():
        try:
            value = str(item)
        except Exception:
            continue
        if value in TARGET_STRINGS:
            refs = [xref.frm for xref in idautils.XrefsTo(item.ea)]
            out.append(
                {
                    "value": value,
                    "ea": hex(item.ea),
                    "xrefs": [hex(x) for x in refs],
                }
            )
    return out


def collect_function(name: str) -> dict:
    ea = ida_name.get_name_ea(idc.BADADDR, name)
    if ea == idc.BADADDR:
        return {"name": name, "found": False}

    func = ida_funcs.get_func(ea)
    if not func:
        return {"name": name, "found": False, "ea": hex(ea)}

    callers = sorted({xref.frm for xref in idautils.XrefsTo(func.start_ea)})
    items = list(idautils.FuncItems(func.start_ea))
    disasm_lines = []
    for ea_item in items[:80]:
        line = idc.generate_disasm_line(ea_item, 0) or ""
        line = ida_lines.tag_remove(line)
        disasm_lines.append(f"{ea_item:#x}: {line}")

    pseudocode = None
    try:
        if ida_hexrays.init_hexrays_plugin():
            cfunc = ida_hexrays.decompile(func.start_ea)
            if cfunc:
                pseudocode = "\n".join(
                    ida_lines.tag_remove(line.line) for line in cfunc.get_pseudocode()
                )
    except Exception as exc:
        pseudocode = f"<decompile failed: {exc}>"

    return {
        "name": name,
        "found": True,
        "ea": hex(func.start_ea),
        "end_ea": hex(func.end_ea),
        "size": func.end_ea - func.start_ea,
        "callers": [hex(x) for x in callers[:64]],
        "disasm": disasm_lines,
        "pseudocode": pseudocode,
    }


def write_outputs(output_dir: str, payload: dict) -> None:
    os.makedirs(output_dir, exist_ok=True)

    with open(os.path.join(output_dir, "key_functions.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    lines = []
    lines.append("# IDA Key Function Dump")
    lines.append("")
    lines.append(f"- Input database: `{ida_kernwin.get_path(idc.PATH_TYPE_IDB)}`")
    lines.append("")
    lines.append("## Strings")
    lines.append("")
    for item in payload["strings"]:
        lines.append(f"- `{item['value']}` @ `{item['ea']}` xrefs={item['xrefs']}")
    lines.append("")

    for item in payload["functions"]:
        lines.append(f"## `{item['name']}`")
        lines.append("")
        if not item.get("found"):
            lines.append("- not found")
            lines.append("")
            continue
        lines.append(f"- start: `{item['ea']}`")
        lines.append(f"- end: `{item['end_ea']}`")
        lines.append(f"- size: `{item['size']}`")
        lines.append(f"- callers: `{item['callers']}`")
        lines.append("")
        lines.append("### Disassembly")
        lines.append("")
        lines.append("```")
        lines.extend(item["disasm"])
        lines.append("```")
        lines.append("")
        if item.get("pseudocode"):
            lines.append("### Pseudocode")
            lines.append("")
            lines.append("```c")
            lines.append(item["pseudocode"])
            lines.append("```")
            lines.append("")

    with open(os.path.join(output_dir, "key_functions.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def main() -> None:
    ida_auto.auto_wait()
    output_dir = resolve_output_dir()
    payload = {
        "strings": collect_strings(),
        "functions": [collect_function(name) for name in TARGETS],
    }
    write_outputs(output_dir, payload)
    idc.qexit(0)


if __name__ == "__main__":
    main()
