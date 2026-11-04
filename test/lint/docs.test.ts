import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderRulesMarkdown } from "../../src/lint/docs.js";
import { docsUrl } from "../../src/lint/engine.js";
import { allRules } from "../../src/lint/rules/index.js";

const markdown = renderRulesMarkdown(allRules);

describe("rules documentation", () => {
  it("keeps docs/rules.md in sync with rule metadata", () => {
    const committed = readFileSync(new URL("../../docs/rules.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(committed, "run `npm run docs:rules` to regenerate docs/rules.md").toBe(markdown);
  });

  it("defines an anchor for every rule's docsUrl", () => {
    for (const rule of allRules) {
      const anchor = docsUrl(rule.meta.id).split("#")[1];
      expect(markdown).toContain(`<a id="${anchor}"></a>`);
      expect(markdown).toContain(`](#${anchor})`);
    }
  });
});
