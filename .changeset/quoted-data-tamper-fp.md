---
"opencode-workflow-guard": patch
---

Settings-tamper and shell-redirect detection run on the quote-stripped residue of each command segment: self-contained quoted spans are command data and their ">" characters are not redirects, while redirect targets keep their value whether quoted or not and quote-concatenated paths keep normalizing.
