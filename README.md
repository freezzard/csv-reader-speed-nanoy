# csv-reader-speed-nanoy

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/freezzard/csv-reader-speed-nanoy/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/freezzard/csv-reader-speed-nanoy/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in replacement for the reference broken-CSV reader: a single-pass scanner that returns exactly the same {columns, rows, errors} answer on every case — including stray carriage returns, quote junk, unterminated quotes and short or long rows — at roughly a third of the reference program's CPU time. `solve.js` holds the reader (`run(input)`), `main.ts` is the harness driver.

## Run it

```sh
node /bot/main.ts
```

The driver reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2k68scpr&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
