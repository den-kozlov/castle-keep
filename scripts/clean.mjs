// Removes dist/ before a build, so a deleted source leaves no stale output in the package.
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
