import { fix } from "../../fix.js";
import type { TextEdit } from "../../types.js";
import { defineRule } from "../helpers.js";
import { cacheMounts, fileOf, shellCommands, stageLabel, systemInstall, type ShellCommand } from "./docker.js";

function isApt(command: ShellCommand): boolean {
  const name = command.words[0]?.split("/").pop();
  return name === "apt-get" || name === "apt";
}

function aptVerb(command: ShellCommand): string | undefined {
  if (!isApt(command)) return undefined;
  for (let index = 1; index < command.words.length; index += 1) {
    const word = command.words[index] ?? "";
    if (word === "-o" || word === "-c" || word === "-t") {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) return word;
  }
  return undefined;
}

function removes(command: ShellCommand, prefix: string): boolean {
  return command.words[0] === "rm" && command.words.some((word) => word.startsWith(prefix));
}

/** Runs an opaque script that may perform the install (`./install.sh`, `bash -c ...`). */
function runsScript(command: ShellCommand): boolean {
  const head = command.words[0] ?? "";
  return /^(ba|da)?sh$|^source$|^\.$/.test(head) || head.startsWith("./") || /\.sh$/.test(head);
}

const NO_RECOMMENDS = /^--no-install-recommends$|^APT::Install-Recommends=(false|0|"0"|"false")$/i;

export default defineRule({
  meta: {
    id: "containers/apt-hygiene",
    ruleset: "containers",
    description: "apt and apk installs in Dockerfiles should skip recommended packages, update and install in one layer, and not leave package caches in the image.",
    rationale:
      "Recommended packages and leftover package indexes add tens of megabytes to every layer that is pushed, pulled, and cached. `apt-get update` in its own RUN creates a layer that BuildKit keeps reusing, so later installs run against a stale index (or fail). Smaller layers mean faster pulls on every ephemeral CI runner and agent sandbox.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/best-practices/#apt-get",
      "https://docs.docker.com/build/cache/optimize/#use-cache-mounts",
      "https://wiki.alpinelinux.org/wiki/Alpine_Package_Keeper#Local_Cache",
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "FROM debian:bookworm-slim\nRUN apt-get update\nRUN apt-get install -y curl",
      good: "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*",
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const recommendsConfigured = /Install-Recommends\s*["']?\s*(false|0|"0")/i.test(file?.content ?? "");
      for (const stage of model.stages) {
        let ordinal = -1;
        for (const instruction of stage.instructions) {
          if (instruction.keyword !== "RUN") continue;
          ordinal += 1;
          const prefix = `stage:${stageLabel(stage)}:run[${ordinal}]`;
          const commands = shellCommands(file, instruction);
          const mounts = cacheMounts(instruction);
          const aptCached = mounts.some((mount) => /^\/var\/(lib|cache)\/apt/.test(mount.target));
          const apkCached = mounts.some((mount) => /^\/(var\/cache\/apk|etc\/apk\/cache)/.test(mount.target));
          const verbs = commands.map(aptVerb);
          const updates = commands.filter((_, index) => verbs[index] === "update");
          const installs = commands.filter((_, index) => ["install", "upgrade", "dist-upgrade", "full-upgrade"].includes(verbs[index] ?? ""));

          for (const command of commands) {
            const install = systemInstall(command.words);
            if (!install) continue;
            if (install.installer === "apt") {
              if (!recommendsConfigured && !command.words.some((word) => NO_RECOMMENDS.test(word))) {
                let edit: TextEdit | undefined;
                if (file && command.offset >= 0) {
                  const tokens = [...command.text.matchAll(/\S+/g)];
                  const verb = tokens[install.verbIndex];
                  if (verb?.index !== undefined) {
                    const at = command.offset + verb.index + verb[0].length;
                    if (!file.content.slice(command.offset, at).includes("\n")) {
                      edit = { path: model.path, start: at, end: at, text: " --no-install-recommends" };
                    }
                  }
                }
                report({
                  path: model.path,
                  line: command.line,
                  key: `${prefix}:install-recommends`,
                  message: `\`${command.words.slice(0, install.verbIndex + 1).join(" ")}\` installs recommended packages too, adding unrequested packages to the layer.`,
                  suggestion:
                    "Add `--no-install-recommends` and list any recommended package you actually need (for example `ca-certificates`) explicitly.",
                  fix: fix("Add --no-install-recommends (list needed recommended packages such as ca-certificates explicitly)", edit),
                });
              }
              if (updates.length > 0 && !aptCached && !commands.some((other) => removes(other, "/var/lib/apt/lists"))) {
                report({
                  path: model.path,
                  line: command.line,
                  key: `${prefix}:apt-lists`,
                  message: "This RUN downloads apt package lists but does not delete them, leaving `/var/lib/apt/lists` in the layer.",
                  suggestion:
                    "End the same RUN with `&& rm -rf /var/lib/apt/lists/*`, or keep the lists out of the image with `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked`.",
                });
              }
            } else if (
              !command.words.includes("--no-cache") &&
              !apkCached &&
              !commands.some((other) => removes(other, "/var/cache/apk"))
            ) {
              report({
                path: model.path,
                line: command.line,
                key: `${prefix}:apk-no-cache`,
                message: `\`${command.words.slice(0, install.verbIndex + 1).join(" ")}\` without \`--no-cache\` leaves the apk index cache in the layer.`,
                suggestion:
                  "Use `apk add --no-cache ...` (it also makes a separate `apk update` unnecessary), or cache-mount `/var/cache/apk` with BuildKit.",
              });
            }
          }

          if (updates.length > 0 && installs.length === 0 && !commands.some(runsScript)) {
            const [update] = updates;
            if (!update) continue;
            report({
              path: model.path,
              line: update.line,
              key: `${prefix}:update-without-install`,
              message:
                "`apt-get update` runs in a RUN without an install, so its layer is cached separately and later installs can use a stale package index.",
              suggestion:
                "Combine update and install in one RUN: `RUN apt-get update && apt-get install -y --no-install-recommends <packages> && rm -rf /var/lib/apt/lists/*`.",
            });
          }
        }
      }
    }
  },
});
