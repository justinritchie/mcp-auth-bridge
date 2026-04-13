#!/bin/bash
# MCP Auth Bridge - Native Host Installer
# Run once after loading the extension in Chrome.
#
# Usage:
#   chmod +x install.sh
#   ./install.sh <extension-id>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.mcp.credentials"
HOST_SCRIPT="$SCRIPT_DIR/native-host/credential_host.py"

# Chrome native messaging hosts directory (macOS)
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

if [ -z "$1" ]; then
    echo ""
    echo "MCP Auth Bridge - Native Host Installer"
    echo "========================================"
    echo ""
    echo "Usage: ./install.sh <chrome-extension-id>"
    echo ""
    echo "To find your extension ID:"
    echo "  1. Open chrome://extensions"
    echo "  2. Enable 'Developer mode' (top right)"
    echo "  3. Load the extension (mcp-auth-bridge/ folder)"
    echo "  4. Copy the ID shown under the extension name"
    echo ""
    exit 1
fi

EXTENSION_ID="$1"

echo ""
echo "MCP Auth Bridge - Native Host Installer"
echo "========================================"
echo ""

# Make host script executable
chmod +x "$HOST_SCRIPT"
echo "Made host script executable: $HOST_SCRIPT"

# Create native messaging manifest
mkdir -p "$CHROME_NM_DIR"

cat > "$CHROME_NM_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "MCP Auth Bridge - generic credential writer for MCP servers",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed native host manifest to: $CHROME_NM_DIR/$HOST_NAME.json"

# Create default credentials directory
mkdir -p "$HOME/.mcp-credentials"
echo "Created credentials directory: $HOME/.mcp-credentials/"

# Verify
echo ""
echo "Verifying..."

if [ -f "$HOST_SCRIPT" ]; then
    echo "  Host script: OK"
else
    echo "  Host script: MISSING"; exit 1
fi

PYTHON_PATH=$(which python3 2>/dev/null || true)
if [ -n "$PYTHON_PATH" ]; then
    echo "  Python3: OK ($PYTHON_PATH)"
else
    echo "  Python3: NOT FOUND"; exit 1
fi

FIRST_LINE=$(head -1 "$HOST_SCRIPT")
if [[ "$FIRST_LINE" == "#!/usr/bin/env python3" ]]; then
    echo "  Shebang: OK"
else
    echo "  Shebang: WARNING"
fi

echo ""
echo "========================================"
echo "  Installation complete!"
echo ""
echo "  Extension ID: $EXTENSION_ID"
echo "  Native host:  $HOST_NAME"
echo ""
echo "  Next steps:"
echo "  1. Restart Chrome (or reload the extension)"
echo "  2. Browse to any configured site while logged in"
echo "  3. Click extension icon → Save"
echo "========================================"
echo ""
