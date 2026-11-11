import { fileURLToPath } from "node:url";
import { startFeedbackHarness } from "../../../scripts/feedback-harness.mjs";

await startFeedbackHarness(fileURLToPath(new URL("../../../", import.meta.url)));
