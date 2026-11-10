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
      "buildImage adds a single layer above any reused base layers. A changed added layer can require transferring more data than a carefully layered image, unless the destination already has the blob. Layered builders separate selected store paths up to their layer limit and group the rest; resulting boundaries and reuse depend on the closure and settings. copyToRoot/contents and runAsRoot/fakeRootCommands are not equivalent APIs. Validate file layout, ownership, permissions and runtime behavior, then measure transfer sizes before migrating.",
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
        else if (keys.has("copyToRoot")) notes.push("adapt `copyToRoot` to `contents` carefully: copying files versus linking store paths can change the root filesystem");
        if (keys.has("runAsRoot")) {
          notes.push("`runAsRoot` runs in a VM and requires the `kvm` system feature on the builder; port it to `fakeRootCommands` (with `enableFakechroot = true;` if the script writes to `/`)");
        }
        count += 1;
        const shownName = name ?? "<name>";
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text}\`${name !== undefined ? ` (image \`${name}\`)` : ""} adds its contents in a single layer. If that layer changes and is absent at the destination, the whole changed blob must transfer; reused base layers are unaffected.${notes.length > 0 ? ` Note: ${notes.join("; ")}.` : ""}`,
          suggestion: `Consider a layered builder only after checking API and filesystem differences. For image \`${shownName}\`, preserve the existing tag/config and adapt all root files, ownership and runAsRoot operations deliberately. streamLayeredImage emits a streaming script; buildLayeredImage emits a tarball. maxLayers limits separation and can regroup paths. Validate the runtime image and measure cold and warm registry transfers; no replacement is applied automatically.`,
          confidence: "high",
          key: `buildImage:${name ?? `#${count}`}`,
        });
      }
    }
  },
});
