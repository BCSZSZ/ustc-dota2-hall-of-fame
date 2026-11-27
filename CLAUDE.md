# Project rules

## Data sources: always OpenDota and STRATZ together

- Every data set that both OpenDota and STRATZ can provide is collected from **both** on every run and combined. Neither is a fallback for the other. Using both is also the cross-check: record where they disagree.
- Only data one source alone has (STRATZ IMP, per-minute hero averages and win-probability curves; OpenDota leaderboard places, parsed replay logs) comes from that source.
- How to combine depends on the data. Merge lists (match IDs, match histories) as a union. For counts and rates, use both (e.g. average the rate levels). For a discrete value they disagree on, keep both, pick one with a stated reason, and log or store the disagreement.
- When one source fails on a run, keep that source's part from the previous run. Never replace combined data with a single-source result that is thinner.
- STRATZ allows two IP addresses per token every 15 minutes, and each GitHub Actions run has a new one. Every STRATZ request goes through `stratz.post_graphql`, which waits once for a free slot. Avoid pulling STRATZ data locally while a deploy run is in progress.
