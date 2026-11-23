import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeCommand,
  describeFailure,
  gh,
  withRetry,
} from "./gh.mts";
import { READY_ISSUES_ARGS } from "./sources/github.mts";

const noSleep = async () => {};

describe("withRetry", () => {
  it("returns the first result when the call succeeds", async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1, sleep: noSleep },
    );

    assert.equal(value, "ok");
    assert.equal(calls, 1);
  });

  it("retries after a failure and returns the later result", async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("TLS handshake timeout");
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1, sleep: noSleep },
    );

    assert.equal(value, "ok");
    assert.equal(calls, 3);
  });

  it("waits longer before each retry", async () => {
    const waits: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("EOF");
        },
        {
          attempts: 4,
          baseDelayMs: 100,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    );

    assert.deepEqual(waits, [100, 200, 400]);
  });

  it("gives up after the attempt count and reports the last error", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`failure ${calls}`);
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep },
      ),
      /failure 3/,
    );

    assert.equal(calls, 3);
  });

  it("reports each retry to the caller", async () => {
    const seen: string[] = [];
    await withRetry(
      async () => {
        if (seen.length === 0) throw new Error("EOF");
        return "ok";
      },
      {
        attempts: 2,
        baseDelayMs: 5,
        sleep: noSleep,
        onRetry: (attempt, error, waitMs) => {
          seen.push(`${attempt}:${error.message}:${waitMs}`);
        },
      },
    );

    assert.deepEqual(seen, ["1:EOF:5"]);
  });
});

describe("gh", () => {
  it("returns the standard output of the command", async () => {
    const out = await gh(["issue", "list"], {
      run: async () => "[]",
      sleep: noSleep,
      baseDelayMs: 1,
    });

    assert.equal(out, "[]");
  });

  it("retries a transient failure", async () => {
    let calls = 0;
    const out = await gh(["issue", "list"], {
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("net/http: TLS handshake timeout");
        return "[]";
      },
      sleep: noSleep,
      baseDelayMs: 1,
    });

    assert.equal(out, "[]");
    assert.equal(calls, 2);
  });

  it("names the command and the last error when GitHub stays unreachable", async () => {
    await assert.rejects(
      gh(["issue", "list", "--state", "open"], {
        run: async () => {
          throw new Error("net/http: TLS handshake timeout");
        },
        attempts: 2,
        sleep: noSleep,
        baseDelayMs: 1,
      }),
      (error: Error) => {
        assert.match(error.message, /gh issue list --state open/);
        assert.match(error.message, /2 attempts/);
        assert.match(error.message, /TLS handshake timeout/);
        return true;
      },
    );
  });
});

describe("describeCommand", () => {
  it("prints a short command in full", () => {
    assert.equal(describeCommand(["issue", "list"]), "gh issue list");
  });

  it("cuts a long command so the line stays readable", () => {
    const printed = describeCommand(READY_ISSUES_ARGS);

    assert.ok(printed.length <= 101, printed);
    assert.ok(printed.endsWith("…"));
    assert.ok(printed.startsWith("gh api graphql"));
  });
});

describe("describeFailure", () => {
  it("prefers the standard error of the command", () => {
    const error = Object.assign(new Error("Command failed: gh issue list"), {
      stderr: "net/http: TLS handshake timeout\n",
    });

    assert.equal(describeFailure(error), "net/http: TLS handshake timeout");
  });

  it("falls back to the message when there is no standard error", () => {
    assert.equal(describeFailure(new Error("spawn gh ENOENT")), "spawn gh ENOENT");
  });

  it("keeps the first line only", () => {
    const error = Object.assign(new Error("failed"), { stderr: "first\nsecond\n" });

    assert.equal(describeFailure(error), "first");
  });
});

