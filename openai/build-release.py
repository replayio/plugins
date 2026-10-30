#!/usr/bin/env python3
"""Validate and build the public Replay.io package, excluding release tooling."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / "replayio"
FILES = {
    "plugin.json", "mcp.json", "LICENSE", "assets/replayio.svg",
    "skills/replayio/SKILL.md",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def https_url(value):
    require(isinstance(value, str), "URL must be a string")
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password, "URL must use HTTPS without credentials")


def reject_credentials(value):
    if isinstance(value, dict):
        for key, item in value.items():
            require(key not in {
                "apps", "hooks", "clientSecret", "client_secret", "headers", "env",
                "test_credentials", "reviewer_instructions", "access_token",
                "refresh_token", "api_key", "password",
            }, "Ineligible component or credential field: " + key)
            reject_credentials(item)
    elif isinstance(value, list):
        for item in value:
            reject_credentials(item)


def validate(manifest, mcp):
    actual = set()
    for path in PACKAGE.rglob("*"):
        require(not path.is_symlink(), "Package must not contain symlinks")
        if path.is_file():
            actual.add(path.relative_to(PACKAGE).as_posix())
    require(actual == FILES, "Unexpected or missing package files: " + str(sorted(actual ^ FILES)))
    reject_credentials(manifest)
    reject_credentials(mcp)
    require(manifest["name"] == "replayio", "Preserve the Replay.io package name")
    require(re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]), "Use a release version")
    require(manifest.get("description") and manifest.get("author", {}).get("name"),
            "Description and author are required")
    openai = manifest["extensions"]["com.openai"]
    listing = openai["interface"]
    for key, limit in {
        "displayName": 30, "shortDescription": 30, "longDescription": 4000,
        "developerName": 80, "category": 120,
    }.items():
        require(isinstance(listing.get(key), str) and 0 < len(listing[key]) <= limit,
                key + " exceeds the submission limit or is missing")
    for key in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        https_url(listing[key])
        require(len(listing[key]) <= 1024, key + " is too long")
    prompts = listing.get("defaultPrompt", [])
    require(isinstance(prompts, list) and len(prompts) <= 3, "At most three starter prompts")
    require(len(set(prompts)) == len(prompts), "Starter prompts must be distinct")
    for prompt in prompts:
        require(isinstance(prompt, str) and 0 < len(prompt) <= 128 and "@" not in prompt,
                "Invalid starter prompt")
    capabilities = listing["capabilities"]
    require(isinstance(capabilities, list) and len(capabilities) <= 20
            and all(isinstance(item, str) and 0 < len(item) <= 120 for item in capabilities),
            "Invalid capability labels")
    for key in ("logo", "composerIcon"):
        require(listing[key] == "./assets/replayio.svg", "Icon must reference the packaged asset")
    icon_path = PACKAGE / "assets/replayio.svg"
    require(icon_path.stat().st_size <= 5 * 1024 * 1024, "Icon exceeds 5 MiB")
    icon = ET.parse(icon_path).getroot()
    width, height = float(icon.attrib["width"]), float(icon.attrib["height"])
    require(width == height and width >= 48, "Icon must be square and at least 48px")
    require(not any(node.tag.split("}")[-1] in {"script", "foreignObject", "image"}
                    for node in icon.iter()), "Icon must be a self-contained vector")
    color = listing["brandColor"]
    require(re.fullmatch(r"#[0-9a-fA-F]{6}", color), "Invalid brand color")
    rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    luminance = sum(c * weight for c, weight in zip(linear, (0.2126, 0.7152, 0.0722)))
    require(1.05 / (luminance + 0.05) >= 2, "Brand color needs 2:1 contrast with white")
    require(set(mcp["mcpServers"]) == {"replay"}, "The store package must have one MCP server")
    server = mcp["mcpServers"]["replay"]
    require(server["type"] == "streamable-http", "Use the hosted HTTP transport")
    require(server["url"] == "https://dispatch.replay.io/mcp", "Preserve the published MCP URL")
    auth = server["extensions"]["com.openai"]["auth"]
    require(auth["type"] == "oauth" and auth["baseScopes"] == ["openid", "profile", "email"],
            "Use the server's existing OAuth scopes")
    cases = openai["review"]["test_cases"]
    for kind, count in (("positive", 5), ("negative", 3)):
        require(len(cases[kind]) == count, "Review needs %s %s cases" % (count, kind))
        for case in cases[kind]:
            for key in ("description", "prompt", "tools_triggered", "expected_behavior"):
                require(isinstance(case.get(key), str) and case[key].strip(),
                        "Missing review case field: " + key)
    demo = openai["review"].get("demo_recording_url")
    if demo:
        https_url(demo)
    skill = (PACKAGE / "skills/replayio/SKILL.md").read_text()
    require(skill.startswith("---\nname: replayio\ndescription: "), "Invalid skill frontmatter")
    require(skill.count("\n---\n") >= 1, "Skill frontmatter is not closed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without creating a ZIP")
    parser.add_argument("--demo-url", help="Actual reviewer-accessible walkthrough URL; never a placeholder")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    manifest = json.loads((PACKAGE / "plugin.json").read_text())
    mcp = json.loads((PACKAGE / "mcp.json").read_text())
    if args.demo_url:
        https_url(args.demo_url)
        manifest["extensions"]["com.openai"]["review"]["demo_recording_url"] = args.demo_url
    validate(manifest, mcp)
    if args.check:
        print("Package validation passed (local checks; dashboard scans are still required).")
        return
    args.output_dir.mkdir(parents=True, exist_ok=True)
    destination = args.output_dir / ("replayio-%s.zip" % manifest["version"])
    # Fixed timestamps, ordering and permissions make identical inputs reproducible.
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(FILES):
            data = ((json.dumps(manifest, indent=2) + "\n").encode()
                    if name == "plugin.json" else (PACKAGE / name).read_bytes())
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksum = destination.with_suffix(".zip.sha256")
    checksum.write_text(digest + "  " + destination.name + "\n")
    print(json.dumps({"zip": str(destination.resolve()), "sha256": digest,
                      "files": sorted(FILES),
                      "demo_url_included": bool(manifest["extensions"]["com.openai"]["review"].get("demo_recording_url")),
                      "review_cases_run": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, ET.ParseError) as error:
        print("Package validation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
