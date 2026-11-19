#!/bin/sh
# Makes Heat's copy of SSCD's weights (#108): the release asset the Dockerfile's SSCD_HEAT_COPY names.
#
# It reads the pin and both URLs from the Dockerfile, fetches Meta's file with the build's own fetch script, which takes
# it only if its bytes match the pin, publishes it with its MIT notice as a release of this repository, then asks the
# published copy for the pinned bytes. Run it again to put a lost asset back; a new model gets a new tag in the
# Dockerfile first. It needs python3 and a signed-in gh, and nothing else of the repository.
#
#   apps/vision/build/publish_weights.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
arg() { sed -n "s/^ARG $1=//p" "$here/../Dockerfile"; }
sha256=$(arg SSCD_SHA256)
copy=$(arg SSCD_HEAT_COPY)
origin=$(arg SSCD_META_ORIGIN)

# https://github.com/<owner>/<repository>/releases/download/<tag>/<file>
path=${copy#https://github.com/}
repository=$(printf %s "$path" | cut -d/ -f1-2)
tag=$(printf %s "$path" | cut -d/ -f5)
file=$(printf %s "$path" | cut -d/ -f6)
if [ -z "$sha256" ] || [ -z "$origin" ] || [ "$path" = "$copy" ] || [ -z "$tag" ] || [ -z "$file" ]; then
  echo "The Dockerfile's SSCD_SHA256, SSCD_HEAT_COPY and SSCD_META_ORIGIN do not read as a pin, a release asset and a URL." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 "$here/fetch_model.py" "$sha256" "$work/$file" "$origin"

cat > "$work/notes.md" <<EOF
SSCD's \`sscd_disc_mixup\` TorchScript model, byte for byte as Meta publishes it at $origin, kept here so that Heat's vision image (\`apps/vision\`) builds whether or not that URL answers (#108).

- SHA-256: \`$sha256\`, which \`apps/vision/Dockerfile\` pins and checks at every build.
- From https://github.com/facebookresearch/sscd-copy-detection, "A Self-Supervised Descriptor for Image Copy Detection" (Pizzi et al., CVPR 2022).
- License: MIT, copyright Meta Platforms, Inc. and affiliates; its notice is the \`SSCD-LICENSE\` file beside the model.
  The project's model weights are under it too: https://github.com/facebookresearch/sscd-copy-detection/issues/12
EOF

if gh release view "$tag" --repo "$repository" > /dev/null 2>&1; then
  gh release upload "$tag" --repo "$repository" --clobber "$work/$file" "$here/SSCD-LICENSE"
else
  gh release create "$tag" --repo "$repository" --latest=false \
    --title "SSCD model weights (sscd_disc_mixup)" --notes-file "$work/notes.md" \
    "$work/$file" "$here/SSCD-LICENSE"
fi

python3 "$here/fetch_model.py" --every "$sha256" "$work/published" "$copy"
echo "Heat's copy answers with the pinned bytes: $copy"
