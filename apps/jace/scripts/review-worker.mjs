// Retired: this worker previously drove the advisory PR-comment lane. Jace's
// supported merge gate is now the Acceptance Record → exact-head evidence
// review → correction-delivery path. This entrypoint intentionally never
// starts the old worker, even when JACE_REVIEW_WORKER is set.
console.error(
  "[review-worker-entrypoint] retired: use the acceptance verification worker; advisory PR review jobs are unsupported.",
);
process.exitCode = 1;
