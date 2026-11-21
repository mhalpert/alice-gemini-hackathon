# Outfits Eval: Live Pipeline vs. One-Call Baseline

Run: `2026-11-21T19:00:55.291Z` · Commit: `bbe90b9` · Test kit + demo: 22 occasions (spec bar: 15 of 20 presentable sets; a set is presentable when >= 2 of 3 outfits pass Argon).

## Headline (test kit + demo)

| Metric | Live Pipeline | One-Call Baseline |
| --- | ---: | ---: |
| Average Argon score | 6.14 / 10 | 5.09 / 10 |
| Presentable sets (bar: 15/20) | 13 / 22 | 3 / 22 |
| Weakest set (min) | 1.00 (gala-men) | 1.33 (gala-men) |
| Dress-code breaks | 0 | 4 |
| Over-budget outfits | 0 | 21 |
| Median time to first outfit | 16.3s | 1.8s |
| p90 time to first outfit | 19.4s | 2.2s |
| Median total time | 18.9s | 2.1s |
| Average cost per build | $0.071 | $0.0009 |

## Per Occasion (test kit + demo)

| Occasion | Pipeline avg | Pipeline presentable | Baseline avg | Baseline presentable |
| --- | ---: | :---: | ---: | :---: |
| first-date-men | 7.67 | yes | 6.33 | no |
| first-date-women | 5.67 | no | 6.33 | no |
| wedding-men | 5.67 | no | 2.33 | no |
| wedding-women | 5.00 | no | 4.00 | no |
| interview-men | 7.33 | yes | 5.00 | no |
| interview-women | 4.67 | no | 2.00 | no |
| brunch-men | 7.00 | yes | 6.67 | no |
| brunch-women | 5.67 | no | 5.67 | no |
| festival-men | 7.33 | yes | 4.33 | no |
| festival-women | 6.00 | no | 5.00 | no |
| club-men | 7.67 | yes | 6.00 | no |
| club-women | 6.00 | yes | 5.67 | no |
| beach-men | 5.33 | yes | 6.00 | no |
| beach-women | 6.67 | yes | 7.00 | yes |
| business-casual-men | 7.00 | yes | 5.33 | no |
| business-casual-women | 5.00 | no | 5.00 | no |
| gala-men | 1.00 | no | 1.33 | no |
| gala-women | 6.33 | yes | 4.00 | no |
| tailgate-men | 8.00 | yes | 5.67 | no |
| apple-picking-women | 5.33 | no | 6.33 | yes |
| rooftop-men | 7.33 | yes | 6.33 | yes |
| rooftop-women | 7.33 | yes | 5.67 | no |

## Team-written messy briefs

Separate stress-test set (5 team-written messy briefs, excluded from the headline above): pipeline 5.80 / 10 (0 / 5 presentable) vs. baseline 5.00 / 10 (0 / 5 presentable).

| Occasion | Pipeline avg | Pipeline presentable | Baseline avg | Baseline presentable |
| --- | ---: | :---: | ---: | :---: |
| hacker-1 | 6.00 | no | 4.00 | no |
| hacker-2 | 5.33 | no | 4.00 | no |
| hacker-3 | 6.67 | no | 6.33 | no |
| hacker-4 | 6.00 | no | 5.00 | no |
| hacker-5 | 5.00 | no | 5.67 | no |

## Where it breaks

- **gala-men** (1.00 avg, min 1): accessory slot shows a black velvet loafer instead of an accessory
- **interview-women** (4.67 avg, min 3): moto-style jacket with asymmetric zippers and belt is too casual and...
- **wedding-women** (5.00 avg, min 4): the heavy dark tortoise-and-gold clutch clashes with the soft pastel...
- **business-casual-women** (5.00 avg, min 4): Plunging, tight knit top is too revealing and casual for the first we...
- **beach-men** (5.33 avg, min 2): Athletic black-striped indoor-soccer style sneakers feel too sporty a...

## What we changed

1. Hard dress-code rules in the plan and pick prompts (formality was the most common failure).
2. The Decisions API gate drops the weakest of 4 planned looks.
3. Hard filters for wedding white and novelty ties at formal events, after the critic caught them.
4. The ready-made library is graded by Argon, serves only looks scoring 6+, and rebuilds weak occasions keeping the best 5.
