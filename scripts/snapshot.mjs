// Copies the build into .sandcastle/run/ for `npm run castle`. The merger runs the gates in this
// checkout and `npm run build` empties dist/, so the running loop must not load from dist/.
import { cpSync, rmSync } from "node:fs";

const root = new URL("../", import.meta.url);
const run = new URL(".sandcastle/run/", root);
rmSync(run, { recursive: true, force: true });
for (const path of ["dist", "templates", "package.json"]) cpSync(new URL(path, root), new URL(path, run), { recursive: true });
