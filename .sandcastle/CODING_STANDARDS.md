# Coding standards

The reviewer loads this file. Keep it short and concrete, and put the rules of
your project here: layout, language, testing, commits.

## Code

- Match the style and the names of the code around the change.
- A comment says what the code cannot show: the reason for a choice that looks
  wrong, a pointer to the spec. Names and code tell the rest.
- Handle the failure of an input you do not control; do not assume it succeeds.

## Testing

- A behaviour change comes with a test. A bug fix starts with a test that fails.
- Name a test for the behaviour it proves, not for the function it calls.
- The gates are the `gates` of `.sandcastle/config.json`; all must pass before a commit.

## Commits

- Conventional Commits, for example `fix(parser): drop the stale token`.
- Name the task in the message, for example `Refs #42`, never `Closes`: the
  merger closes it.
- Short. Key decisions and blockers go in the body, one line each.
- Never push, never open a pull request, never deploy.
