#!/usr/bin/env python3
"""
MCP Auth Bridge - Native Messaging Host

Generic credential writer driven by site config.
Receives credential data from the Chrome extension and writes to the
correct files based on output_format and output_path.

Supports three output formats:
  - cookie_jar: Simple JSON {cookies: {name: value}, domain, captured_at}
  - cookie_editor: Full cookie array (Cookie-Editor compatible)
  - dotenv: .env file with configurable variable mapping

Native messaging protocol: 4-byte little-endian length prefix + JSON payload.
"""

import json
import struct
import sys
from pathlib import Path
from datetime import datetime, timezone

HOME = Path.home()

# Claude Desktop config path (macOS)
CLAUDE_CONFIG = HOME / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"


# ─── Native Messaging I/O ──────────────────────────────────────────────────

def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("<I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    """Write a native messaging message to stdout."""
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ─── Path Resolution ────────────────────────────────────────────────────────

def resolve_path(p):
    """Resolve ~ and relative paths."""
    return Path(p).expanduser().resolve()


# ─── Cookie Jar Handler ─────────────────────────────────────────────────────

def handle_cookie_jar(data):
    """Write cookies as a simple {cookies: {name: value}} JSON file."""
    cookies = data.get("cookies", {})
    domain = data.get("domain", "unknown")
    output_path = resolve_path(data.get("output_path", "~/.mcp-credentials/output.json"))

    if not cookies:
        return {"success": False, "error": "No cookies in payload"}

    output_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "cookies": cookies,
        "domain": domain,
        "captured_at": datetime.now(timezone.utc).isoformat()
    }

    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    return {
        "success": True,
        "file": str(output_path),
        "cookieCount": len(cookies)
    }


# ─── Cookie Editor Handler ──────────────────────────────────────────────────

def handle_cookie_editor(data):
    """Write cookies as a full Cookie-Editor format array."""
    cookies = data.get("cookies", [])
    output_path = resolve_path(data.get("output_path", "~/.mcp-credentials/cookies.json"))

    if not cookies:
        return {"success": False, "error": "No cookies in payload"}

    output_path.parent.mkdir(parents=True, exist_ok=True)

    output_path.write_text(json.dumps(cookies, indent=4, ensure_ascii=False))

    return {
        "success": True,
        "file": str(output_path),
        "cookieCount": len(cookies)
    }


# ─── Dotenv Handler ─────────────────────────────────────────────────────────

def handle_dotenv(data):
    """Write credentials to a .env file with configurable variable mapping."""
    output_path = resolve_path(data.get("output_path", "~/.mcp-credentials/.env"))
    dotenv_mapping = data.get("dotenv_mapping", {})
    dotenv_defaults = data.get("dotenv_defaults", {})

    access_token = data.get("access_token", "")
    refresh_token = data.get("refresh_token") or ""
    extra_fields = data.get("extra_fields", {})

    if not access_token or not access_token.startswith("eyJ"):
        return {"success": False, "error": "Invalid or missing bearer token"}

    # Read existing .env to preserve values we're not updating
    existing = {}
    if output_path.exists():
        for line in output_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                existing[key.strip()] = val.strip().strip("'\"")

    # Build new values from mapping
    env_values = {}

    # Start with defaults (only if not already in existing)
    for key, val in dotenv_defaults.items():
        env_values[key] = existing.get(key, val)

    # Map captured credentials to env vars
    if "access_token" in dotenv_mapping:
        env_values[dotenv_mapping["access_token"]] = access_token
    if "refresh_token" in dotenv_mapping and refresh_token:
        env_values[dotenv_mapping["refresh_token"]] = refresh_token
    elif "refresh_token" in dotenv_mapping:
        env_values[dotenv_mapping["refresh_token"]] = existing.get(
            dotenv_mapping["refresh_token"], "")

    # Map extra fields
    for field, value in extra_fields.items():
        if field in dotenv_mapping and value:
            env_values[dotenv_mapping[field]] = value
        elif field in dotenv_mapping:
            env_values[dotenv_mapping[field]] = existing.get(
                dotenv_mapping[field], "")

    # Preserve any existing values not in our mapping
    for key, val in existing.items():
        if key not in env_values:
            env_values[key] = val

    # Write .env
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# {output_path.stem} configuration",
        "# Updated by MCP Auth Bridge Chrome extension",
        ""
    ]
    for key, val in env_values.items():
        if val:
            lines.append(f"{key}='{val}'")
    output_path.write_text("\n".join(lines) + "\n")

    result = {
        "success": True,
        "env_file": str(output_path),
        "token_length": len(access_token)
    }

    # Write JSON credential file if configured (for live-reload by MCP servers)
    credential_file = data.get("credential_file")
    if credential_file:
        cred_path = resolve_path(credential_file)
        cred_path.parent.mkdir(parents=True, exist_ok=True)
        cred_data = {
            "bearer_token": access_token,
            "access_token": access_token,
            "cart_id": extra_fields.get("cartId", "") or env_values.get("PCEXPRESS_CART_ID", ""),
            "store_id": env_values.get("PCEXPRESS_STORE_ID", "1517"),
            "banner": env_values.get("PCEXPRESS_BANNER", "superstore"),
            "customer_id": env_values.get("PCEXPRESS_CUSTOMER_ID", ""),
            "captured_at": datetime.now(timezone.utc).isoformat()
        }
        if refresh_token:
            cred_data["refresh_token"] = refresh_token
        cred_path.write_text(json.dumps(cred_data, indent=2, ensure_ascii=False))
        result["credential_file"] = str(cred_path)

    return result


# ─── Claude Desktop Config ───────────────────────────────────────────────────

def update_claude_config(claude_config, env_values):
    """Update Claude Desktop config with MCP server entry."""
    server_key = claude_config.get("server_key", "")
    command = claude_config.get("command", "python3")
    args = claude_config.get("args", [])

    # Resolve ~ in args
    resolved_args = [str(resolve_path(a)) if "~" in a else a for a in args]

    config_updated = False
    config_error = None

    if not CLAUDE_CONFIG.parent.exists():
        return {"config_updated": False, "config_warning": "Claude config directory not found"}

    config = None
    backup_path = CLAUDE_CONFIG.with_suffix(".json.bak")

    if CLAUDE_CONFIG.exists():
        try:
            raw = CLAUDE_CONFIG.read_text()
            if not raw.strip():
                config_error = "Config file is empty (Claude Desktop may be running). Close it first."
                return {"config_updated": False, "config_warning": config_error}
            config = json.loads(raw)
            if not isinstance(config, dict):
                config_error = "Config file is not a JSON object. Skipping."
                return {"config_updated": False, "config_warning": config_error}
        except json.JSONDecodeError as e:
            config_error = f"Invalid JSON in config (Claude Desktop may be running). Close it first. Error: {e}"
            return {"config_updated": False, "config_warning": config_error}
        except OSError as e:
            config_error = f"Cannot read config (file may be locked). Error: {e}"
            return {"config_updated": False, "config_warning": config_error}

    if config is None:
        config = {}

    # Backup before modification
    if CLAUDE_CONFIG.exists():
        try:
            import shutil
            shutil.copy2(str(CLAUDE_CONFIG), str(backup_path))
        except OSError:
            pass

    # Merge — only touch our server key
    config.setdefault("mcpServers", {})
    config["mcpServers"][server_key] = {
        "command": command,
        "args": resolved_args,
        "env": {k: v for k, v in env_values.items() if v}
    }

    # Validate: don't lose existing servers
    if backup_path.exists():
        try:
            old_config = json.loads(backup_path.read_text())
            old_servers = set(old_config.get("mcpServers", {}).keys())
            new_servers = set(config.get("mcpServers", {}).keys())
            if old_servers - new_servers:
                return {
                    "config_updated": False,
                    "config_warning": f"Would lose servers {old_servers - new_servers}. Aborted."
                }
        except Exception:
            pass

    CLAUDE_CONFIG.write_text(json.dumps(config, indent=2))
    return {"config_updated": True}


# ─── Main Router ─────────────────────────────────────────────────────────────

def main():
    try:
        message = read_message()
        if not message:
            send_message({"success": False, "error": "No message received"})
            return

        output_format = message.get("output_format", "")
        site = message.get("site", "unknown")

        if output_format == "cookie_jar":
            result = handle_cookie_jar(message)
        elif output_format == "cookie_editor":
            result = handle_cookie_editor(message)
        elif output_format == "dotenv":
            result = handle_dotenv(message)
        else:
            result = {"success": False, "error": f"Unknown output_format: {output_format} for site: {site}"}

        send_message(result)

    except Exception as e:
        try:
            send_message({"success": False, "error": str(e)})
        except Exception:
            pass


if __name__ == "__main__":
    main()
