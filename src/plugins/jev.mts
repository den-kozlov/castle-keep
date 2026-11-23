// Implementer model per issue, picked by Jev — a pilot.
//
// A small issue does not need the strong model. When an implementer starts, the
// plugin asks Jev (TypeSafe's decision model, through OpenRouter) one yes/no
// question about its issue: can a cheap model finish it alone? At P(yes) ≥
// `easyThreshold` the issue goes to the cheap model; every other issue stays on the
// strong model.
//
// The strong model is the implementer role and the cheap one `cheapModel` of this
// plugin in the config file. Without `cheapModel` the pilot is off. The plugin
// sets the model in its pre-start hook and notes the score on the agent row.
// Only the implementer changes; the other roles keep their own models.
//
// The default threshold 0.9 is conservative and not tuned.
//
// Jev sees only the issue title and body. It fails safe: no key, a network
// error or an odd answer keeps the issue on the strong model, and the run goes on.
//
// The key is OPENROUTER_API_KEY in .sandcastle/.env or in the environment.
// Without it the pilot is off and every issue runs on the strong model.

import { readEnvFile } from "../env-file.mts";
import type { IssueText, Plugin } from "../plugin.mts";

/** The default `easyThreshold`: at or above this P(yes) the implementer runs on the cheap model. */
export const EASY_THRESHOLD = 0.9;

export interface ModelChoice {
  model: string;
  /** One line for the agent row. */
  note: string;
}

const JEV_URL = "https://openrouter.ai/api/v1/systemone";
const JEV_MODEL = "jev-1.13";
const JEV_TIMEOUT_MS = 30_000;

/** Longest issue body sent to Jev, in characters. */
const MAX_BODY_CHARS = 12_000;

/** The question the plugin owns; `project` only goes in front of it. A change here needs a new replay. */
export const EASY_QUESTION =
  "Can a cheap, fast coding model finish this task alone on the first try, with the project's tests and builds passing?";

const easyQuestion = (project: string) => ({
  type: "choice",
  instructions: project ? `${project} ${EASY_QUESTION}` : EASY_QUESTION,
  criteria: {
    yes: "A small, local change with a clear recipe: few files, one layer, no new protocol, schema or cross-step state.",
    no: "Anything larger, subtler or unclear.",
  },
});

export interface Tier extends ModelChoice {
  /** Undefined when Jev gave no usable answer. */
  pEasy?: number;
}

/** Returns P(yes) for one issue. Replaced in tests. */
export type EasyAsker = (issue: IssueText) => Promise<number>;

export interface TierOptions {
  strongModel: string;
  cheapModel: string;
  /** False turns the pilot off: no question to Jev. Defaults to true. */
  pilot?: boolean;
  /** Defaults to Jev through OpenRouter, or undefined when there is no key. */
  ask?: EasyAsker;
  /** What the project is, one or two sentences, put in front of the question. */
  project?: string;
  /** At or above this P(yes) the cheap model is picked. Defaults to EASY_THRESHOLD. */
  threshold?: number;
}

/** The rule itself: cheap at or above the threshold, strong otherwise. */
export function pickTier(
  pEasy: number | undefined,
  strongModel: string,
  cheapModel: string,
  threshold = EASY_THRESHOLD,
): Tier {
  if (pEasy === undefined || !Number.isFinite(pEasy)) {
    return { model: strongModel, note: "no Jev answer" };
  }
  const shown = `P(easy) ${pEasy.toFixed(2)}`;
  return pEasy >= threshold
    ? { model: cheapModel, pEasy, note: shown }
    : { model: strongModel, pEasy, note: shown };
}

/**
 * Picks the implementer model for every issue. Never throws: a failed
 * question leaves that issue on the strong model.
 */
export async function assignTiers(
  issues: IssueText[],
  options: TierOptions,
): Promise<Map<string, Tier>> {
  const tiers = new Map<string, Tier>();
  if (options.pilot === false) {
    for (const issue of issues) {
      tiers.set(issue.id, { model: options.strongModel, note: "pilot off: no cheapModel" });
    }
    return tiers;
  }
  const ask = options.ask ?? jevAsker(options.project ?? "");

  await Promise.all(
    issues.map(async (issue) => {
      let pEasy: number | undefined;
      let failure: string | undefined;
      if (ask) {
        try {
          pEasy = await ask(issue);
        } catch (error) {
          failure = (error as Error).message.split("\n")[0];
        }
      }
      const tier = pickTier(pEasy, options.strongModel, options.cheapModel, options.threshold);
      if (!ask) tier.note = "pilot off: no OPENROUTER_API_KEY";
      else if (failure) tier.note = `Jev failed: ${failure}`;
      tiers.set(issue.id, tier);
    }),
  );
  return tiers;
}

function jevAsker(project: string): EasyAsker | undefined {
  const key = readEnvFile().OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!key) return undefined;

  return async (issue) => {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: `Title: ${issue.title}\n\n${issue.body.slice(0, MAX_BODY_CHARS)}`,
        questions: { easy: easyQuestion(project) },
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as {
      answers?: { easy?: { probabilities?: { yes?: number } } };
    };
    const pEasy = json.answers?.easy?.probabilities?.yes;
    if (typeof pEasy !== "number") throw new Error("answer has no P(yes)");
    return pEasy;
  };
}

/** True when the pilot has a cheaper model to pick. */
export function pilotOn(strongModel: string, cheapModel: string | null): boolean {
  return cheapModel !== null && cheapModel !== strongModel;
}

export interface JevOptions {
  /** What the project is, one or two sentences, put in front of the question. */
  project?: string;
  /** The cheaper implementer model; null or absent leaves the pilot off. */
  cheapModel?: string | null;
  /** At or above this P(yes) the implementer runs on the cheap model. */
  easyThreshold?: number;
  /** Replaces the question to Jev. For tests. */
  ask?: EasyAsker;
}

/** The plugin: Jev picks the model of the implementer of each issue, in its pre-start hook. */
export function jevPilot(options: JevOptions): Plugin {
  return {
    name: "jev",
    async preStart({ role, task, proposed }) {
      if (role !== "implementer" || !task) return undefined;
      const tiers = await assignTiers([task], {
        strongModel: proposed.model,
        cheapModel: options.cheapModel ?? proposed.model,
        pilot: pilotOn(proposed.model, options.cheapModel ?? null),
        project: options.project,
        threshold: options.easyThreshold,
        ask: options.ask,
      });
      const tier = tiers.get(task.id);
      return tier ? { model: tier.model, note: tier.note } : undefined;
    },
  };
}
