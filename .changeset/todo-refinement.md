---
"opencode-workflow-guard": patch
---

A reworded active task is a refinement, not a silent deletion, when its text keeps every word of the original and adds at least one more. The write now passes, the task keeps its original mutation window, and the acceptance is journaled as `todo_refined`. A reword that drops or substitutes a word still blocks, and a one-word task still needs an exact match.
