---
"opencode-workflow-guard": patch
---

Dynamic shell syntax blocks now name the detected construct and a concrete remedy instead of a generic message: command/process substitution ($( ), backticks, <( ) / >( )) points to rewriting with literal values or separate literal commands and to simulating with guard_why, malformed quoting points to simple balanced quoting, and the IFS/ambiguous-whitespace variants name their construct. The fail-closed decision, block code, and all detectors are unchanged.