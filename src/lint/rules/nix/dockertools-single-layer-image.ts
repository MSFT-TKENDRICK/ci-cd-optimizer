import type { NixFile, NixIdent } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  attrKeys,
  attrsetOf,
  bindingNamed,
  callArgument,
  inheritStatements,
  lintableNixFiles,
  stringAt,
  validateStringLists,
  wordOffsets,
} from "./expr.js";

/** Whether a bare `buildImage` in this file refers to `dockerTools.buildImage` (`inherit (pkgs.dockerTools) buildImage;` or `with pkgs.dockerTools;`). */
function bareBuildImageIsDockerTools(file: NixFile): boolean {
  if (wordOffsets(file, "nix2container").length > 0) return false;
  const inherited = inheritStatements(file).some(
    (statement) => statement.source !== undefined && /(?:^|\.)dockerTools$/.test(statement.source) && statement.names.some(({ name }) => name === "buildImage"),
  );
  return inherited || /(?<![A-Za-z0-9_'.-])with\s+(?:[A-Za-z_][A-Za-z0-9_'-]*\.)*dockerTools\s*;/.test(file.masked);
}

function isDockerToolsBuildImage(ident: NixIdent, bareAllowed: boolean): boolean {
  if (ident.segments.at(-1) !== "buildImage" || ident.segments.includes("nix2container")) return false;
  if (ident.segments.length === 1) return bareAllowed;
  return ident.segments.at(-2) === "dockerTools";
}

function literal(file: NixFile, open: number, key: string): string | undefined {
  const binding = bindingNamed(file, open, key);
  if (!binding) return undefined;
  const string = stringAt(file, binding.valueStart);
  return string && !string.interpolated ? string.value : undefined;
}

export default defineRule({
  meta: {
    id: "nix/dockertools-single-layer-image",
    ruleset: "nix",
    description: "Container images built with `dockerTools.buildImage` put the whole closure in a single layer.",
    rationale:
      "`dockerTools.buildImage` creates one layer for all files and dependencies it adds (on top of `fromImage`, if any). Any change to any store path in the closure — the application, a library, a config file — yields a new layer digest, so the registry push, the pull on every node and the CI cache all transfer the complete closure again, and images built from the same nixpkgs share no layers. `streamLayeredImage`/`buildLayeredImage` create one layer per store path up to `maxLayers` (default 100), putting the most \"popular\" (most depended-on) paths in their own layers and grouping the rest, so an application change only replaces the layers that actually changed. `buildImage`'s `runAsRoot` also needs a KVM-capable builder, while the layered builders use `fakeRootCommands` without a VM.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict", "insights"],
    requires: [],
    defaultOptions: { allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "allow"),
    references: [
      "https://nixos.org/manual/nixpkgs/stable/#ssec-pkgs-dockerTools-buildImage",
      "https://nixos.org/manual/nixpkgs/stable/#ssec-pkgs-dockerTools-streamLayeredImage",
      "https://nixos.org/manual/nixpkgs/stable/#ssec-pkgs-dockerTools-buildLayeredImage",
      "https://github.com/nlewo/nix2container",
    ],
    impact: "medium",
    example: {
      bad: 'pkgs.dockerTools.buildImage {\n  name = "api";\n  copyToRoot = [ api pkgs.cacert ];\n  config.Cmd = [ "/bin/api" ];\n}',
      good: 'pkgs.dockerTools.streamLayeredImage {\n  name = "api";\n  contents = [ api pkgs.cacert ];\n  config.Cmd = [ "/bin/api" ];\n}',
    },
  },
  check({ project, options, report }) {
    const allowed = new Set(options.allow);
    for (const file of lintableNixFiles(project)) {
      if (allowed.has(file.path)) continue;
      const bareAllowed = bareBuildImageIsDockerTools(file);
      let count = 0;
      for (const ident of file.idents) {
        if (!isDockerToolsBuildImage(ident, bareAllowed)) continue;
        const arg = callArgument(file, ident);
        const open = arg ? attrsetOf(file, arg) : undefined;
        if (open === undefined) continue;
        const keys = attrKeys(file, open);
        const name = literal(file, open, "name");
        if (name !== undefined && allowed.has(name)) continue;
        const notes: string[] = [];
        if (keys.has("fromImage")) notes.push("the `fromImage` layers are reused, but everything this call adds is still one layer");
        if (keys.has("contents")) notes.push("`contents` is deprecated in `buildImage` (it warns and expects `copyToRoot`), but it is exactly the attribute `streamLayeredImage` takes");
        else if (keys.has("copyToRoot")) notes.push("move the `copyToRoot` paths to `contents` — the layered builders link them into `/` and give each store path its own layer");
        if (keys.has("runAsRoot")) {
          notes.push("`runAsRoot` runs in a VM and requires the `kvm` system feature on the builder; port it to `fakeRootCommands` (with `enableFakechroot = true;` if the script writes to `/`)");
        }
        count += 1;
        const shownName = name ?? "<name>";
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text}\`${name !== undefined ? ` (image \`${name}\`)` : ""} packs the image's entire Nix closure into a single layer: any change to any store path produces a new layer that is pushed and pulled in full, and no layers are shared with other images.${notes.length > 0 ? ` Note: ${notes.join("; ")}.` : ""}`,
          suggestion: `Build a layered image instead (the arguments are not interchangeable: \`copyToRoot\` becomes \`contents\`, \`runAsRoot\` becomes \`fakeRootCommands\`):\n\npkgs.dockerTools.streamLayeredImage {\n  name = "${shownName}";\n  tag = "latest";\n  contents = [ /* former copyToRoot paths */ ];\n  config = { /* unchanged */ };\n  # maxLayers = 100; (default) one layer per store path, most-depended-on paths first\n}\n\n\`streamLayeredImage\` builds a script that streams the image instead of storing a tarball: \`$(nix build --print-out-paths .#image) | docker image load\`. Use \`buildLayeredImage\` if you need the tarball in the store, or nix2container (\`github:nlewo/nix2container\`) to skip pushing layers that are already in the registry.`,
          confidence: "high",
          key: `buildImage:${name ?? `#${count}`}`,
        });
      }
    }
  },
});
