# skills

Published skills land here, one directory per skill, each containing a
`SKILL.md`.

Nothing is written here directly. A skill reaches this directory only when it
has cleared both gates in the pipeline:

1. the rule-based skill score (`skillScoring.publishThreshold` in
   `scanner/config.json`), and
2. the reviewer stage, which has to return `approve`.

Even then it arrives as a pull request, not a commit — the pipeline decides what
is worth proposing, a human decides what is worth keeping.

## Reviewing one

Two things are worth checking before merging, because they are the failure modes
the automated stages are weakest against:

- **Is every step actually in the source project's documentation?** Each
  `SKILL.md` links its source repo and lists the files that were read, and quotes
  the passage it was drawn from. Spot-check the specifics — commands, flags,
  config keys — against those.
- **Would the `description` line route correctly?** It is the sentence an agent
  matches against when deciding whether to load the skill. If it would fire on
  tasks this skill can't help with, it's worse than not having the skill.
