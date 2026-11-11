Knight stage art lives in `packages/web/public/art/nft/{1-4}.png` and is copied to
`packages/web/public/art/knights/{level}-{state}.png` (same image for every state;
the UI applies CSS filters for dormant, wounded and victory). NFT metadata is
served from the repo-root copies in `art/knights/knight-{1-4}.png`.

The previous SVG rasteriser (cartoon knight and Phoenix boss) has been removed.
Do not regenerate those assets.

Challenge card icons are the same stage art at `packages/web/public/art/icons/icon-{1-4}.png`.
