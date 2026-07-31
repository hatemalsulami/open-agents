#!/usr/bin/env bash
# Downloads the WebLLM runtime so OpenAgent can run open-source models locally
# on WebGPU. Only needed for the "Local open-source model" provider — Chrome's
# built-in AI and all cloud providers work without it.
#
# Chrome extensions may not load remote scripts, so the library has to live on
# disk. It is not committed to the repo: 6 MB of minified third-party code is
# better fetched from its source than vendored blindly.
#
#   ./scripts/fetch-vendor.sh
#
# Then reload the extension at chrome://extensions.

set -euo pipefail

VERSION="${WEBLLM_VERSION:-0.2.84}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
DEST="$DEST_DIR/web-llm.js"
URL="https://esm.run/@mlc-ai/web-llm@${VERSION}"

mkdir -p "$DEST_DIR"
echo "Downloading @mlc-ai/web-llm@${VERSION}…"
curl -fsSL --retry 3 "$URL" -o "$DEST.tmp"

# A truncated or error-page download would fail confusingly at runtime.
if ! grep -q "CreateMLCEngine" "$DEST.tmp"; then
  rm -f "$DEST.tmp"
  echo "Download did not contain the expected WebLLM exports. Aborting." >&2
  exit 1
fi

mv "$DEST.tmp" "$DEST"
echo "✓ Saved $(du -h "$DEST" | cut -f1) to vendor/web-llm.js"
echo "  Now reload OpenAgent at chrome://extensions and pick"
echo "  'Local open-source model (WebLLM + WebGPU)' in setup."
