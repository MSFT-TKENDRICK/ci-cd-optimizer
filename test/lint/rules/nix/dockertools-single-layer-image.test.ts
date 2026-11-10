import rule from "../../../../src/lint/rules/nix/dockertools-single-layer-image.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "layered builders",
      files: {
        "image.nix": nix(
          "{ pkgs, api }:",
          "{",
          '  stream = pkgs.dockerTools.streamLayeredImage { name = "api"; contents = [ api ]; };',
          '  tarball = pkgs.dockerTools.buildLayeredImage { name = "api"; contents = [ api ]; };',
          '  withDb = pkgs.dockerTools.buildLayeredImageWithNixDb { name = "nix"; contents = [ pkgs.nix ]; };',
          "}",
        ),
      },
    },
    {
      name: "nix2container's buildImage is layered",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs, nix2container }:",
          "    let",
          "      n2c = nix2container.packages.x86_64-linux.nix2container;",
          "    in {",
          '      packages.x86_64-linux.image = n2c.buildImage { name = "api"; copyToRoot = [ ]; };',
          "    };",
          "}",
        ),
      },
    },
    {
      name: "comments, strings, attribute names and an unrelated local buildImage",
      files: {
        "default.nix": nix(
          "{ pkgs }:",
          "let",
          "  buildImage = args: args;",
          "in",
          "{",
          '  # pkgs.dockerTools.buildImage { name = "x"; }',
          '  description = "pkgs.dockerTools.buildImage { name = \\"x\\"; }";',
          '  image = buildImage { name = "x"; };',
          "  builder = pkgs.dockerTools.buildImage;",
          "}",
        ),
      },
    },
    {
      name: "allow option by image name and by file path",
      options: { allow: ["legacy", "nix/old-image.nix"] },
      files: {
        "image.nix": nix("{ pkgs }:", 'pkgs.dockerTools.buildImage { name = "legacy"; copyToRoot = [ pkgs.hello ]; }'),
        "nix/old-image.nix": nix("{ pkgs }:", 'pkgs.dockerTools.buildImage { name = "old"; copyToRoot = [ pkgs.hello ]; }'),
      },
    },
  ],
  invalid: [
    {
      name: "buildImage with copyToRoot",
      files: {
        "image.nix": nix(
          "{ pkgs, api }:",
          "pkgs.dockerTools.buildImage {",
          '  name = "api";',
          "  copyToRoot = [ api pkgs.cacert ];",
          '  config.Cmd = [ "/bin/api" ];',
          "}",
        ),
      },
      errors: [
        {
          line: 2,
          messageIncludes: "`pkgs.dockerTools.buildImage` (image `api`) adds its contents in a single layer. If that layer changes and is absent at the destination, the whole changed blob must transfer; reused base layers are unaffected. Note: adapt `copyToRoot` to `contents` carefully: copying files versus linking store paths can change the root filesystem.",
        },
      ],
    },
    {
      name: "buildImage with fromImage, deprecated contents and runAsRoot",
      files: {
        "image.nix": nix(
          "{ dockerTools, app, base }:",
          "dockerTools.buildImage {",
          '  name = "app";',
          "  fromImage = base;",
          "  contents = [ app ];",
          "  runAsRoot = ''",
          "    mkdir -p /data",
          "  '';",
          "}",
        ),
      },
      errors: [
        {
          line: 2,
          messageIncludes:
            "Note: the `fromImage` layers are reused, but everything this call adds is still one layer; `contents` is deprecated in `buildImage` (it warns and expects `copyToRoot`), but it is exactly the attribute `streamLayeredImage` takes; `runAsRoot` runs in a VM and requires the `kvm` system feature",
        },
      ],
    },
    {
      name: "bare buildImage via inherit and via with",
      files: {
        "a.nix": nix("{ pkgs }:", "let", "  inherit (pkgs.dockerTools) buildImage;", "in", 'buildImage { name = "a"; copyToRoot = [ pkgs.hello ]; }'),
        "b.nix": nix("{ pkgs }:", "with pkgs.dockerTools;", "buildImage {", "  copyToRoot = [ pkgs.hello ];", "}"),
      },
      errors: [
        { path: "a.nix", line: 5, messageIncludes: "`buildImage` (image `a`) adds its contents in a single layer. If that layer changes and is absent at the destination, the whole changed blob must transfer; reused base layers are unaffected. Note: adapt `copyToRoot` to `contents` carefully: copying files versus linking store paths can change the root filesystem." },
        { path: "b.nix", line: 3, messageIncludes: "`buildImage` adds its contents in a single layer. If that layer changes and is absent at the destination, the whole changed blob must transfer; reused base layers are unaffected. Note: adapt `copyToRoot` to `contents` carefully: copying files versus linking store paths can change the root filesystem." },
      ],
    },
  ],
});
