## Outfit Eval
Across 22 test-kit + demo occasions graded by the Argon critic, the live outfit pipeline averages 6.1/10 with 13/22 client-presentable sets, compared to 5.1/10 and 3/22 for a one-call Flash Lite baseline.
The pipeline had 0 dress-code breaks and 0 over-budget outfits (baseline: 4 dress-code breaks, 21 over-budget).
Median time to first outfit is 16.3s (p90 19.4s), median total build time is 18.9s, and average cost is $0.071 per build.
On 5 separate team-written messy briefs, the pipeline averages 5.8/10 (0/5 presentable) vs. 5.0/10 (0/5) for baseline.
See `eval/results/RESULTS.md` for the full breakdown and weakest occasions.
Run it yourself:
`node --env-file-if-exists=.env.local eval/run.ts && node eval/report.ts`
