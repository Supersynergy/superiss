# Security

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Supersynergy/superiss/security/advisories/new). If that channel is unavailable, contact the maintainer through the [GitHub profile](https://github.com/Supersynergy) before disclosing exploit details publicly.

Superiss is a local coordination tool. Treat executable task contracts as code: a general `verify` or runner command executes with the invoking user's permissions. `allowed_paths` selects fingerprint inputs; it does not confine arbitrary commands.

The explicit macOS `local_zero` workflow adds a Seatbelt sandbox, a restricted environment and bounded execution. It fails when the required sandbox is unavailable. These protections do not apply to unrelated applications or general-purpose commands. See [ZERO-RECOVERY.md](ZERO-RECOVERY.md).

Keep HTTP bound to loopback and Unix sockets private. Do not expose the daemon directly to the internet. Keep databases, admin tokens, job data and receipts out of public repositories. A person who can modify the local database or executable is outside the receipt trust boundary.

Source hashes establish which declared files were checked. They do not establish that a weak oracle proves the intended behavior. Review identities and client-supplied smoke/artifact observations are host assertions, not independently authenticated attestations.
