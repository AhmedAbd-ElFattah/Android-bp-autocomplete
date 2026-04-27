#!/usr/bin/env python3
"""
generate_schema.py — Extract Soong module property definitions from an AOSP
checkout and write them to soong_schema.json.

Usage:
    python3 tools/generate_schema.py /path/to/aosp/root
    python3 tools/generate_schema.py /path/to/aosp/root --output custom_name.json
    python3 tools/generate_schema.py /path/to/aosp/root --verbose

The AOSP root must already have a completed Soong documentation build at:
    <aosp_root>/out/soong/docs/soong_build.html

See the README for step-by-step instructions on generating that file.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urljoin

try:
    from bs4 import BeautifulSoup
except ImportError:
    print(
        "Error: 'beautifulsoup4' is not installed.\n"
        "Run:  pip install beautifulsoup4",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Path constants (relative to the AOSP root)
# ---------------------------------------------------------------------------

# Soong documentation lives under out/soong/docs/ after a successful build.
SOONG_DOCS_SUBPATH = Path("out") / "soong" / "docs"
SOONG_HTML_FILENAME = "soong_build.html"

# Canary files/directories that confirm the path is actually an AOSP root.
# Checking several of these makes accidental false-positives very unlikely.
AOSP_CANARY_PATHS = [
    "build/soong",          # Soong build system source
    "build/make",           # GNU Make build system
    "bionic",               # Bionic libc
    "frameworks/base",      # Android frameworks
    "Android.bp",           # Root-level Android.bp
]


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validate_aosp_root(root: Path) -> None:
    """
    Raise SystemExit with a clear message if `root` does not look like an
    AOSP checkout root.

    Checks:
      1. The path exists and is a directory.
      2. At least one of the known AOSP canary paths exists inside it.
      3. The Soong documentation HTML file exists.
    """
    if not root.exists():
        _die(
            f"Path does not exist: {root}\n"
            "Provide the absolute path to the root of an AOSP checkout."
        )

    if not root.is_dir():
        _die(
            f"Path is not a directory: {root}\n"
            "Provide the root directory of an AOSP checkout, not a file."
        )

    # Check that at least one well-known AOSP directory is present.
    canary_hits = [p for p in AOSP_CANARY_PATHS if (root / p).exists()]
    if not canary_hits:
        _die(
            f"The directory does not appear to be an AOSP root: {root}\n"
            "\n"
            "None of the expected AOSP paths were found:\n"
            + "\n".join(f"  {root / p}" for p in AOSP_CANARY_PATHS)
            + "\n\n"
            "Make sure you are pointing at the top-level directory of an "
            "Android source checkout (the one that contains 'build/', "
            "'bionic/', 'frameworks/', etc.)."
        )

    # Check that the Soong documentation was generated.
    docs_dir  = root / SOONG_DOCS_SUBPATH
    html_file = docs_dir / SOONG_HTML_FILENAME

    if not docs_dir.exists():
        _die(
            f"Soong documentation directory not found: {docs_dir}\n"
            "\n"
            "The Soong docs have not been built yet. Run:\n"
            "  source build/envsetup.sh\n"
            "  lunch <target>\n"
            "  m soong_docs\n"
            "\n"
            "See the README for full prerequisite instructions."
        )

    if not html_file.exists():
        _die(
            f"Soong documentation HTML not found: {html_file}\n"
            "\n"
            "The file '{SOONG_HTML_FILENAME}' was expected inside:\n"
            f"  {docs_dir}\n"
            "\n"
            "Try rebuilding the docs:\n"
            "  m soong_docs\n"
            "\n"
            "If the directory exists but the file is missing, the build may "
            "have failed partway through."
        )


def _die(message: str) -> None:
    """Print an error message and exit with a non-zero status."""
    print(f"\nError: {message}\n", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def collect_module_links(html_file: Path, docs_dir: Path) -> list[dict]:
    """
    Parse the module-types table in soong_build.html and return a list of
    dicts, each with keys:
        package  — Go package path (e.g. "android/soong/cc")
        module   — module type name (e.g. "cc_binary")
        url      — absolute path to the HTML file + anchor (file#anchor)
    """
    with open(html_file, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    table = soup.find("table", class_="module_types")
    if not table:
        _die(
            f"Could not find the module-types table in {html_file}.\n"
            "The HTML structure may have changed between AOSP releases. "
            "Please open a bug with the AOSP version you are using."
        )

    tbody = table.find("tbody")
    if not tbody:
        _die(f"The module-types table in {html_file} has no <tbody>.")

    base_url = str(docs_dir) + "/"
    entries  = []

    for row in tbody.find_all("tr"):
        cols = row.find_all("td")
        if len(cols) != 2:
            continue

        package = cols[0].get_text(strip=True)
        for link in cols[1].find_all("a"):
            module_name = link.get_text(strip=True)
            href        = link.get("href", "")
            if not href:
                continue

            full_url = urljoin(base_url, href)
            entries.append({"package": package, "module": module_name, "url": full_url})

    if not entries:
        _die(
            f"No module entries were found in the table in {html_file}.\n"
            "The file may be empty or malformed. Try rebuilding with 'm soong_docs'."
        )

    return entries


def parse_module_props(file_with_anchor: str) -> tuple[list[str], dict]:
    """
    Parse a single module section from its HTML file and return:
        keys  — ordered list of property names
        props — dict mapping each property name to {"type": ..., "description": ...}

    `file_with_anchor` is a string of the form "/abs/path/to/file.html#anchor".
    """
    if "#" not in file_with_anchor:
        raise ValueError(
            f"Expected a path with a '#' anchor fragment, got: {file_with_anchor}"
        )

    file_path, anchor = file_with_anchor.split("#", 1)

    if not Path(file_path).exists():
        raise FileNotFoundError(
            f"HTML file referenced from the module table does not exist: {file_path}\n"
            "The docs directory may be incomplete. Try 'm soong_docs' again."
        )

    with open(file_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    header = soup.find("h2", id=anchor)
    if not header:
        # The anchor not being present is not fatal — some links in the table
        # point to modules defined in included files. Warn and return empty.
        return [], {}

    keys  = []
    props = {}

    for elem in header.find_next_siblings():
        # Stop when the next top-level module section starts.
        if elem.name == "h2":
            break

        # Only "simple" property divs carry the structured data we need.
        if elem.name != "div" or "simple" not in elem.get("class", []):
            continue

        prop_id = elem.get("id", "")

        # Skip properties that belong to a different module (can happen when
        # module sections are defined in the same file and share a page).
        if not prop_id.startswith(anchor + "."):
            continue

        name_tag = elem.find("b")
        if not name_tag:
            continue

        key = name_tag.get_text(strip=True)
        if not key:
            continue

        type_tag  = elem.find("i")
        type_text = type_tag.get_text(strip=True) if type_tag else ""

        # Build a clean description by stripping the key and type from the
        # full text content of the element.
        full_text = elem.get_text(" ", strip=True)
        desc      = full_text.replace(key, "", 1).strip()
        if type_text:
            desc = desc.replace(type_text, "", 1).strip()
        # Remove stray leading punctuation left after the substitutions above.
        desc = desc.lstrip(", ").strip()
        # Collapse internal newlines that can appear inside multi-line <p> tags.
        desc = " ".join(desc.split())

        keys.append(key)
        props[key] = {"type": type_text, "description": desc}

    return keys, props


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_mapping(entries: list[dict], verbose: bool) -> dict:
    """
    Walk every module entry, parse its properties, and return the mapping dict
    suitable for writing to soong_schema.json.
    """
    mapping       = {}
    total         = len(entries)
    errors        = []

    for i, item in enumerate(entries, start=1):
        module_name = item["module"]

        if verbose:
            print(f"  [{i:>4}/{total}] {module_name}", flush=True)

        try:
            keys, props = parse_module_props(item["url"])
        except (FileNotFoundError, ValueError) as exc:
            errors.append(f"  - {module_name}: {exc}")
            continue

        if module_name not in mapping:
            mapping[module_name] = []

        for k in keys:
            desc = props[k]["description"].replace("\n", " ")
            mapping[module_name].append({
                "key":         k,
                "type":        props[k]["type"],
                "description": desc,
            })

    if errors:
        print(
            f"\nWarning: {len(errors)} module(s) could not be parsed "
            "(they will be absent from the output):",
            file=sys.stderr,
        )
        for e in errors:
            print(e, file=sys.stderr)

    return mapping


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Extract Soong module property definitions from an AOSP checkout "
            "and write them to soong_schema.json."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 tools/generate_schema.py ~/aosp\n"
            "  python3 tools/generate_schema.py ~/aosp --output soong_data.json\n"
            "  python3 tools/generate_schema.py ~/aosp --verbose\n"
        ),
    )
    parser.add_argument(
        "aosp_root",
        metavar="AOSP_ROOT",
        help="Absolute or relative path to the root of an AOSP checkout.",
    )
    parser.add_argument(
        "--output", "-o",
        metavar="FILE",
        default="soong_schema.json",
        help=(
            "Output file path. Defaults to 'soong_schema.json' in the "
            "current working directory."
        ),
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print each module name as it is processed.",
    )

    args = parser.parse_args()

    # ── Resolve and validate the AOSP root ────────────────────────────────────
    aosp_root = Path(args.aosp_root).expanduser().resolve()
    print(f"AOSP root : {aosp_root}")
    validate_aosp_root(aosp_root)

    docs_dir  = aosp_root / SOONG_DOCS_SUBPATH
    html_file = docs_dir / SOONG_HTML_FILENAME
    print(f"Docs HTML : {html_file}")

    # ── Collect module links from the top-level table ─────────────────────────
    print("Scanning module table...")
    entries = collect_module_links(html_file, docs_dir)
    print(f"Found {len(entries)} module entries.")

    # ── Parse each module's properties ────────────────────────────────────────
    print("Parsing module properties..." + (" (verbose)" if args.verbose else ""))
    mapping = build_mapping(entries, verbose=args.verbose)
    print(f"Parsed {len(mapping)} unique module types.")

    # ── Write output ──────────────────────────────────────────────────────────
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=4, ensure_ascii=False)

    print(f"Written   : {output_path}")
    print("Done.")


if __name__ == "__main__":
    main()
