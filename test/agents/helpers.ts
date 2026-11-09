import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A workflow with no job timeout: `workflow/job-timeout` (warn, fixable) reports it. */
export const MISSING_TIMEOUT = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n";
export const WORKFLOW = ".github/workflows/ci.yml";

export interface TempDirs {
  make(prefix?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** Real (symlink-resolved) temporary directories, removed by `cleanup`. */
export function tempDirs(): TempDirs {
  const made: string[] = [];
  return {
    async make(prefix = "cicd-agents-") {
      const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
      made.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}

export async function write(root: string, path: string, text: string): Promise<string> {
  const file = join(root, ...path.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
