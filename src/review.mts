// The reviewer's architecture verdict.
//
// The reviewer polishes a branch but must not redesign it: a wrong shape
// belongs to a human. It says so with a tag in its last message, and the
// harness keeps that branch out of the merge and hands the issue over.
//
// A missing tag counts as `sound`, the behaviour before the verdict existed:
// a reviewer that forgets the tag must not stop every merge.

export type ArchitectureVerdict = "sound" | "blocked" | "missing";

const VERDICT = /<architecture>\s*(sound|blocked)\s*<\/architecture>/g;

/** The last verdict tag in the reviewer output, or "missing". */
export function architectureVerdict(stdout: string): ArchitectureVerdict {
  let verdict: ArchitectureVerdict = "missing";
  for (const match of stdout.matchAll(VERDICT)) {
    verdict = match[1] as "sound" | "blocked";
  }
  return verdict;
}

// On a `sound` verdict the reviewer also names the strongest block candidate
// it weighed and why the shape passed, so a careful pass shows in the event
// log. A missing note is not an error.
const NOTE = /<architecture-note>([\s\S]*?)<\/architecture-note>/g;

/** The text of the last note tag in the reviewer output, or "". */
export function architectureNote(stdout: string): string {
  let note = "";
  for (const match of stdout.matchAll(NOTE)) {
    note = match[1].trim();
  }
  return note;
}

export interface ReviewOutcome {
  outcome: "done" | "blocked";
  note: string | undefined;
  blocked: boolean;
}

/** The `agent-end` outcome and note of a finished review. */
export function reviewOutcome(stdout: string): ReviewOutcome {
  switch (architectureVerdict(stdout)) {
    case "blocked":
      return { outcome: "blocked", note: "reviewer blocked the architecture", blocked: true };
    case "missing":
      return {
        outcome: "done",
        note: "reviewer gave no architecture verdict; treated as sound",
        blocked: false,
      };
    case "sound":
      return { outcome: "done", note: architectureNote(stdout) || undefined, blocked: false };
  }
}

// An implementer that only a human can move on ends with the needs-human
// signal and says why in a tag. The harness then hands the issue over instead
// of closing it (see NEEDS_HUMAN in ./engine.mts).
const NEEDS_HUMAN = /<needs-human>([\s\S]*?)<\/needs-human>/g;

/** The text of the last needs-human tag in the implementer output, or "". */
export function needsHumanReason(stdout: string): string {
  let reason = "";
  for (const match of stdout.matchAll(NEEDS_HUMAN)) {
    reason = match[1].trim().replace(/\s+/g, " ");
  }
  return reason;
}
