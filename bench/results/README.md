# Historical multiworker benchmark — 20 October 2026

These artifacts compare an earlier 0.8 debug baseline against a 0.9 debug candidate on the same synthetic warm workload: 10,000 backlog tasks; 1/2/4/8 virtual socket clients; three paired repeats at each level. Setup and seeding are outside the measured batches.

[Raw data](multiworker-debug.json) · [historical evaluator output](multiworker-sgg.json) · [evidence boundary](PROVENANCE.md)

| Virtual clients | Baseline accepted tasks/s | Candidate accepted tasks/s |
| ---: | ---: | ---: |
| 1 | 4.82 | 5.67 |
| 2 | 8.43 | 11.13 |
| 4 | 12.24 | 20.37 |
| 8 | 14.23 | 30.35 |

The recorded summed batch durations were 8,160 ms and 4,863 ms (40.4% less time for that experiment). There were 90 accepted tasks per arm. These are historical measurements, not a fresh public-release benchmark. Later service/recovery/default changes are outside this paired comparison.

The data do not establish cold-start behavior, production latency, an optimal number of coding agents, model-cost savings or superiority over Beads and the other tools in the market table. Current acceptance is described in [release validation](../../docs/VALIDATION.md).
