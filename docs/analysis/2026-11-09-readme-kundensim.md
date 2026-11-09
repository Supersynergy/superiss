# README clarity check — 9 November 2026

Scope: the English and German entry pages for Superiss 1.3, with the linked recovery instructions. This is a synthetic reader review and a local executable demo, not customer acceptance or a conversion experiment.

## What changed

The entry pages now lead with task ownership and checked completion. Four practical jobs replace the long feature introduction. A three-command demo runs the complete claim, verify and close loop in a temporary store. Setup, recovery, WOOP, integrations and detailed limits have direct links.

The pages retain the boundaries: WOOP creates a plan, a passing proof covers its check, actor names are not authentication, and a simple reminder list may not need this workflow.

## Six reader situations

| Reader's question | Evidence | Result |
|---|---|---|
| What does this do, and is it for me? | Opening statement and “Where it fits” | Synthetic review: pass |
| Can I try a complete working example? | Three commands and the existing quickstart | Synthetic review: pass; demo executed locally |
| How do parallel agents avoid stale writes? | Claims, leases and epochs; linked operation catalog | Synthetic review: pass |
| How do I resume interrupted work? | Direct recovery link in both languages | First review: unclear; link and recovery instructions added, then checked locally |
| Where do I connect an MCP client? | Explicit database command and setup link | Synthetic review: pass |
| When is this unnecessary? | Simple reminders counterexample | Synthetic review: pass |

One independent read-only reviewer assessed the document before the recovery-link fix. Five scenarios passed; recovery was unclear. The author then added and checked that link. No second independent pass is claimed.

## Executable and source checks

The existing `examples/quickstart.py` ran successfully: claim acquired; close without proof rejected; declared check passed; fenced close and final closed state read back. The demo uses a temporary database and no model provider.

Local publication-link checks and the whitespace diff check passed. Both README files passed the text-noise threshold of fewer than five findings per 1,000 words. These checks establish document and example behavior, not reader preference.

## Evidence limits and next measurement

A read-only lookup in the available customer-question registry found no Superiss-specific customer evidence. An unrelated result was excluded. The six situations therefore remain synthetic. No customer quotes, willingness to pay, completion times, savings or conversion changes were measured.

A future human check should ask first-time users to identify the product, run the demo and locate recovery without assistance. Record completion and confusion before claiming an improvement in customer response.
