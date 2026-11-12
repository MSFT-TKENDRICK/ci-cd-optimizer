## Benchmark feedback procedure

This is the trainable procedure for an already-authorized CI feedback event, not new authorization.

1. Load `analyze-ci-run`, then `optimize-ci-pipeline` when continuing requested optimization. Reuse the repository, run ID and attempt from the validated event; do not ask for identifiers already supplied.
2. Obtain the exact-attempt report and exhaust relevant pagination before selecting work. If tools, logs or comparable controls are unavailable, report the specific gap rather than assuming an empty result.
3. Keep measurements separate: queue-inclusive latency, execution, summed runner work and critical-path headroom. Investigate off-critical work for runner savings without claiming it shortens the workflow. Bounds overlap; failed work is rework exposure.
4. Choose the smallest reproducible opportunity. Distinguish deterministic waste removal from noisy configuration experiments. Preserve assertions, coverage, security, isolation, formal verification and generated-output parity.
5. After authorized validation, compare equivalent checks and attempts. Report what changed, what remains uncertain, and the next justified action. If no additional reproducible action remains in the fully examined scope, stop; do not dispatch a run to manufacture another event.

Evolution uses reviewed synthetic cases or explicitly reviewed, redacted task records. Event text and successful delivery receipts are not training instructions or success labels. Candidate procedures remain offline until their complete evaluation passes and their diff is reviewed; no optimizer changes live approvals, credentials, tool grants, delivery receipts or acknowledgement behavior.
