import { describe, expect, it } from "vitest";
import { flagSet, parseBuildCommand, parseCacheEntry } from "../../../../src/lint/rules/containers/buildx.js";

describe("bounded Buildx command and cache parsing", () => {
  it.each([
    "docker buildx build --help .",
    "docker buildx build -h .",
    "docker build --version",
    "docker buildx build $BUILD_FLAGS .",
    "docker buildx build ${{ inputs.flags }} .",
  ])("does not interpret query modes or unknown option expansions: %s", (command) => {
    expect(parseBuildCommand(command)).toBeUndefined();
  });

  it.each(["--builder remote", "--builder=remote"])("retains a global builder selection: %s", (option) => {
    expect(parseBuildCommand(`docker buildx ${option} build .`)?.flags.get("builder")).toEqual(["remote"]);
  });

  it("ends flag parsing at the literal separator", () => {
    const build = parseBuildCommand("docker buildx build -- --load");
    expect(build?.positional).toEqual(["--load"]);
    expect(build?.flags.has("load")).toBe(false);
  });

  it("retains ordered flags and honors the final boolean value", () => {
    const build = parseBuildCommand("docker buildx build --load --load=false -f first -f second .");
    expect(build?.flags.get("file")).toEqual(["first", "second"]);
    expect(build && flagSet(build, "load")).toBe(false);
  });

  it("does not decode literal quote characters twice", () => {
    const build = parseBuildCommand(`docker buildx build --cache-to '"type=gha","scope=one,two"' -f '"special".Dockerfile' .`);
    expect(build?.flags.get("file")).toEqual(['"special".Dockerfile']);
    const cache = parseCacheEntry(build?.flags.get("cache-to")?.[0] ?? "");
    expect(cache.type).toBe("gha");
    expect(cache.attributes.get("scope")).toBe("one,two");
  });

  it("parses quoted CSV fields without treating their contents as additional attributes", () => {
    const cache = parseCacheEntry('type=gha,"scope=one,mode=min,two","mode=max"');
    expect(cache.attributes.get("scope")).toBe("one,mode=min,two");
    expect(cache.attributes.get("mode")).toBe("max");
  });

  it("decodes doubled CSV quote characters", () => {
    expect(parseCacheEntry('type=gha,"scope=a""b"').attributes.get("scope")).toBe('a"b');
  });

  it.each(['type=gha,"scope=unterminated', 'type=gha,scope="not-a-quoted-field"', 'type=gha,"scope=ok"trailing'])(
    "treats malformed CSV as unknown: %s", (text) => {
      expect(parseCacheEntry(text).type).toBe("");
      expect(parseCacheEntry(text).attributes.size).toBe(0);
    },
  );
});
