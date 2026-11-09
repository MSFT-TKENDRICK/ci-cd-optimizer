import rule from "../../../../src/lint/rules/testing/fixed-sleep.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const withService = (body: string) =>
  `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    services:\n      db:\n        image: postgres:16\n    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "short pause", files: withService("      - run: sleep 2\n") },
    { name: "bare sleep without anything started is rate limiting, not readiness", files: wf("      - run: sleep 30\n") },
    { name: "sleep before the service starts", files: wf("      - run: sleep 30\n      - run: docker compose up -d\n") },
    { name: "readiness polling loop", files: withService("      - run: until curl -fsS localhost:8080; do sleep 5; done\n") },
    { name: "compose --wait", files: wf("      - run: docker compose up -d --wait\n") },
    { name: "dynamic duration", files: wf("      - run: sleep $DELAY\n") },
    { name: "GNU timeout is not a wait", files: wf("      - run: timeout 60 npm test\n") },
    { name: "custom threshold", files: withService("      - run: sleep 10\n"), options: { minSeconds: 30 } },
  ],
  invalid: [
    {
      files: wf("      - run: docker compose up -d && sleep 30\n      - run: npm run test:e2e\n"),
      errors: [{ line: 6, messageIncludes: "fixed 30 seconds" }],
    },
    { name: "minutes suffix with a service container", files: withService("      - run: sleep 1m\n"), errors: [{ messageIncludes: "60 seconds" }] },
    { name: "backgrounded server on the same line", files: wf("      - run: npm start & sleep 20\n"), errors: 1 },
    { name: "backgrounded server in an earlier step", files: wf("      - run: npm start &\n      - run: sleep 20\n"), errors: 1 },
    { name: "docker run --detach", files: wf("      - run: docker run --detach -p 5432:5432 postgres\n      - run: sleep 15\n"), errors: 1 },
    { name: "nohup", files: wf("      - run: |\n          nohup ./server &\n          sleep 15\n"), errors: 1 },
    {
      name: "PowerShell Start-Sleep after Start-Process",
      files: wf("      - shell: pwsh\n        run: |\n          Start-Process ./server.exe\n          Start-Sleep -Seconds 15\n"),
      errors: 1,
    },
    { name: "cmd timeout /t after start /b", files: wf("      - shell: cmd\n        run: |\n          start /b server.exe\n          timeout /t 10 /nobreak\n"), errors: 1 },
  ],
});
