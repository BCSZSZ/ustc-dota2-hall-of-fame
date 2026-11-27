# Project rules

## Data sources: always OpenDota and STRATZ together

- Every data set that both OpenDota and STRATZ can provide is collected from **both** on every run and combined. Neither is a fallback for the other. Using both is also the cross-check: record where they disagree.
- Only data one source alone has (STRATZ IMP, per-minute hero averages and win-probability curves; OpenDota leaderboard places, parsed replay logs) comes from that source.
- A source that structurally has no data for a data set is dropped for it instead of being queried: STRATZ does not index league 19224 (its league match list is empty), and its `seasonLeaderboardRank` is empty for every league player. Check coverage with real data before adding a source, and note the exclusion here.
- How to combine depends on the data. Merge lists (match IDs, match histories) as a union. For counts and rates, use both (e.g. average the rate levels). For a discrete value they disagree on, keep both, pick one with a stated reason, and log or store the disagreement.
- When one source fails on a run, keep that source's part from the previous run. Never replace combined data with a single-source result that is thinner.
- STRATZ allows two IP addresses per token every 15 minutes, and each GitHub Actions run has a new one. Every STRATZ request goes through `stratz.post_graphql`, which waits once for a free slot. Avoid pulling STRATZ data locally while a deploy run is in progress.

## Rating terms on the site: MMR only

- Every rating the site shows is called MMR, and its name says what it contains. Do not call computed values 天梯分, 综合分, 基准分 or 估分.
- 手填 MMR: what a player entered on the MMR page. 段位估算: MMR estimated from the OpenDota and STRATZ medals. 基础 MMR: the manual one if present, otherwise the medal estimate, otherwise the league median.
- MMR: 基础 MMR plus the in-house Elo adjustment from league results (weight by league games, see matchmaker.html).
- A position's MMR (also just "MMR" on the site, never 号位 MMR): MMR plus that position's offset from the past year's normal games (ranked and unranked), or MMR − 500 for a rarely played position. 阵容 MMR: a team's weighted mean of its positions' MMR.
- The past year's ranked and unranked non-turbo games are 常规比赛, never 天梯 or 公开比赛.
