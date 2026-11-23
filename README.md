[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/suwanangcrew025-ops/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/suwanangcrew025-ops/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Swiftfold — a faster static site generator

A faster drop-in for make.fun's `makefun-site` 1.0.0, for the "Build a static site
faster" bounty (site-generator-speed-01-run-20261122). `main.ts` is the prescribed
driver — it reads every case from `/input/cases.json`, answers each with `run`
from `solve.js`, and writes `/output/answers.json`. `solve.js` is the entry: a
dependency-free ES module whose `run(input)` returns exactly makefun-site 1.0.0's
answer — the output tree of the site build, as a JSON object of every path it
writes and that file's text, byte for byte — for every `{ site, templates, files }`,
under makefun-site's own front matter, template dialect, Markdown subset, slug
rule and build report (its code is the reference wherever the two differ).

## How it is faster

The reference lexes every body into tokens and then renders them, and escapes
text with one regex call per character. Swiftfold instead:

- walks each body once, in a single pass, emitting HTML directly instead of a
  lex-then-render token walk;
- escapes HTML in one scan with a single regex, returning the original string
  untouched when nothing needs escaping;
- flattens each template once, with its includes inlined (depth-capped exactly
  like the reference), instead of re-resolving includes per page;
- memoises slugs per case (reset for every case, so one case never feeds the
  next) and avoids per-page object churn beyond what the templates can observe.

## Verification

On the kit's practice set (3 cases drawn before the competition opened), all 3
answers are byte-identical to makefun-site 1.0.0's, the output is deterministic
across two runs, and the entry runs about 3.5x faster than the baseline on CPU
time (median ~163 ms vs ~580 ms locally).
