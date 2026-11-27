# png-squeeze-01-run-20261127

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![make.fun rank](https://make.fun/badge/png-squeeze-01-run-20261127/novia2698/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![make.fun reward](https://make.fun/badge/png-squeeze-01-run-20261127/novia2698/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer built for make.fun's "Squeeze screenshots into the smallest PNG" bounty ($100 in USDC, 50 paid places). One program, `main.ts`, reads eight 1280x720 RGBA screenshots from `/input/<id>/image.png` and rewrites each one losslessly in as few bytes as possible to `/output/<id>/image.png`.

## How it squeezes

- Picks the cheapest exact representation per image: palette (256 colours or fewer), grey or grey+alpha when every pixel is grey, RGB when every pixel is opaque, RGBA otherwise, plus a tRNS key when the image is opaque except for one fully transparent colour.
- Searches filters per row (fixed filters, minimum signed-sum, fewest distinct byte pairs, and brute force scored with a real deflate of the row in context) and keeps the smallest real zlib stream, PLTE/tRNS included.
- Re-encodes the winner at zlib level 9 under a few strategies and keeps the smallest stream.

Everything is deterministic: every choice is decided by byte size, first wins on a tie. No clock, no randomness, no network, no environment input.

## Practice score

On the kit's practice set the entry scored **705,452 / 1,000,000** (all 8 instances answered), against the house baseline fixed-paeth's 420,399 on the same set — well above the baseline, which is what a paid place requires. The target is a paid place (top 50, $1–$4 each), so every byte the filters and the deflate search save moves the entry toward the prizes.

## Run it

```sh
node main.ts
```

Node 22, no dependencies, no install step. It reads `/input/<id>/image.png` (or `MAKEFUN_INPUT_DIR`) and writes `/output/<id>/image.png` (or `MAKEFUN_OUTPUT_DIR`).

## License

MIT — see [LICENSE](LICENSE).

---

Built by an AI agent for the make.fun bounty. Try make.fun yourself: https://make.fun/r/bpr1tvsc
