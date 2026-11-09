import rule from "../../../../src/lint/rules/redundancy/repeated-job-setup.js";
import { ruleTester } from "../../rule-tester.js";

const setup = `      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
`;

const job = (id: string, command: string, prefix = setup) => `  ${id}:
    runs-on: ubuntu-24.04
    steps:
${prefix}      - run: ${command}
`;

const workflow = (...jobs: string[]) => `on: push
jobs:
${jobs.join("")}`;

ruleTester(rule, {
  valid: [
    { name: "only two jobs share setup", files: workflow(job("lint", "npm run lint"), job("test", "npm test")) },
    {
      name: "setup differs in one job",
      files: workflow(
        job("lint", "npm run lint"),
        job("test", "npm test"),
        job("build", "npm run build", setup.replace("cache: npm", "cache: ''")),
      ),
    },
    {
      name: "shared prefix without setup or install",
      files: workflow(
        ...["a", "b", "c"].map((id) =>
          job(id, `./run.sh ${id}`, "      - uses: actions/checkout@v4\n      - run: ./prepare.sh\n      - run: ./configure.sh\n"),
        ),
      ),
    },
    {
      name: "already uses a local composite action",
      files: workflow(
        ...["a", "b", "c"].map((id) =>
          job(id, `npm run ${id}`, "      - uses: actions/checkout@v4\n      - uses: ./.github/actions/setup\n      - run: npm ci\n"),
        ),
      ),
    },
    {
      name: "minJobs option",
      files: workflow(job("lint", "npm run lint"), job("test", "npm test"), job("build", "npm run build")),
      options: { minJobs: 4 },
    },
  ],
  invalid: [
    {
      files: workflow(job("lint", "npm run lint"), job("test", "npm test"), job("build", "npm run build")),
      errors: [{ line: 3, messageIncludes: "3 jobs start with the same 3 setup steps" }],
    },
    {
      name: "across workflows",
      files: {
        ".github/workflows/ci.yml": workflow(job("lint", "npm run lint"), job("test", "npm test")),
        ".github/workflows/release.yml": workflow(job("publish", "npm publish")),
      },
      errors: [{ path: ".github/workflows/ci.yml", messageIncludes: ".github/workflows/release.yml#publish" }],
    },
    {
      name: "step names do not matter",
      files: workflow(
        job("lint", "npm run lint"),
        job("test", "npm test", setup.replace("- run: npm ci", "- name: Install\n        run: npm ci")),
        job("build", "npm run build"),
      ),
      errors: 1,
    },
  ],
});
