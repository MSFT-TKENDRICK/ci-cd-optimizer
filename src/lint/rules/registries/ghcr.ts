import type { StepModel } from "../../parsers/workflow.js";
import { withString } from "../../parsers/workflow.js";
import type { SourceFile } from "../../types.js";
import { commandsOf, defineRule, expandedJobSteps, type ExpandedStep } from "../helpers.js";
import { isDockerHub, isInternalBase, registryHost, stageLabel } from "../containers/docker.js";

const GHCR = "ghcr.io";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;

interface Destination {
  /** Literal image reference (may end in an unresolved expression). */
  ref: string;
  /** Registry host, when the literal part of the reference determines it. */
  host?: string;
  path: string;
  line: number;
  key: string;
  via: string;
}

function usesAction(step: StepModel, name: string): boolean {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name === name;
}

/** Registry host of an image reference, or undefined when an expression or variable hides it. */
function hostOf(ref: string): string | undefined {
  const dynamic = ref.search(/\$\{\{|\$/);
  const literal = dynamic >= 0 ? ref.slice(0, dynamic) : ref;
  if (dynamic >= 0 && !literal.includes("/")) return undefined;
  if (!literal) return undefined;
  return registryHost(dynamic >= 0 ? `${literal}x` : literal);
}

function registryName(host: string): string {
  return isDockerHub(host) ? "Docker Hub" : `\`${host}\``;
}

function imageName(ref: string): string {
  const path = ref.split("@")[0] ?? ref;
  const last = path.split("/").pop() ?? path;
  const name = last.split(":")[0] ?? last;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name.toLowerCase() : "<image>";
}

function lineOfText(file: SourceFile | undefined, fromLine: number, text: string): number {
  if (!file) return fromLine;
  const lines = file.content.split(/\r?\n/);
  for (let index = Math.max(0, fromLine - 1); index < lines.length; index += 1) {
    if (lines[index]?.includes(text)) return index + 1;
  }
  return fromLine;
}

function listEntries(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n/) : [];
  return items.flatMap((item) => (item.includes("${{") ? [item] : item.split(","))).map((item) => item.trim()).filter(Boolean);
}

/** Image names from docker/metadata-action `images` (plain names or `name=...,enable=...` CSV entries). */
function metadataImages(step: StepModel): string[] {
  const value = step.with.get("images")?.value;
  const lines = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n/) : [];
  const images: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/(^|,)\s*name=/.test(trimmed)) {
      const attributes = new Map(
        trimmed.split(",").map((part) => {
          const [key = "", ...rest] = part.split("=");
          return [key.trim(), rest.join("=").trim()] as const;
        }),
      );
      const name = attributes.get("name");
      if (name && attributes.get("enable") !== "false") images.push(name);
    } else {
      images.push(...trimmed.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return images;
}

function words(command: string): string[] {
  return (command.match(/(?:\$\{\{.*?\}\}|\S)+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Image references a shell command pushes: `docker push`, `podman push`, or `docker buildx build --push -t`. */
function commandPushes(command: string): string[] | undefined {
  let parts = words(command);
  if (parts[0] === "sudo") parts = parts.slice(1);
  const [tool, ...rest] = parts;
  if (!tool || !["docker", "podman", "buildah"].includes(tool.split("/").pop() ?? "")) return undefined;
  const args = rest[0] === "image" || rest[0] === "buildx" ? rest.slice(1) : rest;
  const [action, ...tail] = args;
  if (action === "push") {
    const ref = tail.find((word) => !word.startsWith("-"));
    return ref ? [ref] : [];
  }
  if (action !== "build" && action !== "bud") return undefined;
  if (!tail.some((word) => word === "--push" || word === "--push=true")) return undefined;
  const tags: string[] = [];
  tail.forEach((word, index) => {
    if (word === "-t" || word === "--tag") {
      const next = tail[index + 1];
      if (next) tags.push(next);
    } else if (/^(-t|--tag)=/.test(word)) tags.push(word.replace(/^(-t|--tag)=/, ""));
  });
  return tags;
}

/** Registry a `docker login` command authenticates to (Docker Hub when no server is given). */
function commandLogin(command: string): string | undefined {
  const parts = words(command);
  const index = parts.findIndex((word, position) => word === "login" && /(^|\/)(docker|podman)$/.test(parts[position - 1] ?? ""));
  if (index < 0) return undefined;
  const args = parts.slice(index + 1);
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    if (/^(-u|--username|-p|--password)$/.test(word)) {
      position += 1;
      continue;
    }
    if (word.startsWith("-") || word === "|" || word.startsWith(">")) continue;
    return word;
  }
  return "docker.io";
}

function loginHost(registry: string): string {
  return registry.replace(/^https?:\/\//, "").split("/")[0]?.toLowerCase() ?? registry;
}

const SUGGESTION = (image: string) =>
  `Push to \`ghcr.io/\${{ github.repository_owner }}/${image}\` instead: log in with \`docker/login-action\` (\`registry: ghcr.io\`, \`username: \${{ github.actor }}\`, \`password: \${{ secrets.GITHUB_TOKEN }}\`) and grant the job \`permissions: packages: write\`. GHCR images are scoped to the organization, linked to the repository, need no extra registry secrets, and pull fast from Actions runners.`;

export default defineRule({
  meta: {
    id: "registries/ghcr",
    ruleset: "registries",
    description: "Container images built in CI should be published to GitHub Container Registry (ghcr.io).",
    rationale:
      "Publishing to GHCR keeps images next to the code: the workflow's GITHUB_TOKEN can push without long-lived registry secrets, packages inherit organization permissions and link to the repository, and runners pull from GHCR without Docker Hub's anonymous rate limits. Shared base and dependency layers published once to GHCR can then be reused by every service in the monorepo.",
    kind: "policy",
    defaultSeverity: "info",
    presets: ["github"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
      "https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-docker-images#publishing-images-to-github-packages",
      "https://docs.docker.com/docker-hub/usage/",
    ],
    impact: "low",
    example: {
      bad: "- uses: docker/login-action@v3\n  with:\n    username: ${{ secrets.DOCKERHUB_USER }}\n    password: ${{ secrets.DOCKERHUB_TOKEN }}\n- uses: docker/build-push-action@v6\n  with:\n    push: true\n    tags: acme/api:latest",
      good:
        "permissions:\n  packages: write\nsteps:\n  - uses: docker/login-action@v3\n    with:\n      registry: ghcr.io\n      username: ${{ github.actor }}\n      password: ${{ secrets.GITHUB_TOKEN }}\n  - uses: docker/build-push-action@v6\n    with:\n      push: true\n      tags: ghcr.io/${{ github.repository_owner }}/api:latest",
    },
  },
  check({ project, report }) {
    const ghcrOwners: string[] = [];
    let pushesToGhcr = false;

    for (const model of [...project.workflows, ...project.actions]) {
      for (const job of model.jobs) {
        const entries = expandedJobSteps(project, model, job);
        const destinations: Destination[] = [];
        const logins: Array<{ host: string; entry: ExpandedStep; line: number; key: string }> = [];
        let unknownPushes = 0;

        for (const entry of entries) {
          const { step, path } = entry;
          const file = project.files.get(path);
          if (usesAction(step, "docker/build-push-action")) {
            const push = step.with.get("push");
            if (!push || push.kind !== "literal" || String(push.value) !== "true") continue;
            const tags = step.with.get("tags");
            const raw = withString(step, "tags")?.trim();
            const output = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.tags\s*\}\}$/.exec(raw ?? "");
            if (output) {
              const meta = entries.find((candidate) => candidate.step.id === output[1] && usesAction(candidate.step, "docker/metadata-action"));
              const images = meta ? metadataImages(meta.step) : [];
              const metaFile = meta ? project.files.get(meta.path) : undefined;
              for (const image of images) {
                const host = hostOf(image);
                if (!meta) continue;
                destinations.push({
                  ref: image,
                  ...(host ? { host } : {}),
                  path: meta.path,
                  line: lineOfText(metaFile, meta.step.with.get("images")?.line ?? meta.step.line, image),
                  key: `${meta.step.key}:image:${image}`,
                  via: "`docker/metadata-action` images",
                });
              }
              if (images.length === 0) unknownPushes += 1;
              continue;
            }
            const refs = listEntries(tags?.value);
            if (refs.length === 0) unknownPushes += 1;
            for (const ref of refs) {
              const host = hostOf(ref);
              destinations.push({
                ref,
                ...(host ? { host } : {}),
                path,
                line: lineOfText(file, tags?.line ?? step.line, ref),
                key: `${step.key}:tag:${ref}`,
                via: "`docker/build-push-action`",
              });
            }
            continue;
          }
          if (usesAction(step, "docker/login-action")) {
            const registry = step.with.get("registry");
            if (registry && registry.kind !== "literal") continue;
            const host = registry ? loginHost(String(registry.value)) : "docker.io";
            logins.push({ host, entry, line: registry?.line ?? step.uses?.line ?? step.line, key: `${step.key}:login` });
            continue;
          }
          for (const { command, line } of commandsOf(step)) {
            const login = commandLogin(command);
            if (login !== undefined) {
              if (!login.includes("$")) logins.push({ host: loginHost(login), entry, line, key: `${step.key}:login:${loginHost(login)}` });
              continue;
            }
            const pushed = commandPushes(command);
            if (!pushed) continue;
            if (pushed.length === 0) unknownPushes += 1;
            for (const ref of pushed) {
              const host = hostOf(ref);
              destinations.push({ ref, ...(host ? { host } : {}), path, line, key: `${step.key}:push:${ref}`, via: "`docker push`" });
            }
          }
        }

        const known = destinations.filter((destination) => destination.host !== undefined && !LOCAL_HOST.test(destination.host));
        unknownPushes += destinations.filter((destination) => destination.host === undefined).length;
        for (const destination of known) {
          const host = destination.host ?? "";
          if (host === GHCR) {
            pushesToGhcr = true;
            const owner = destination.ref.split("/")[1];
            if (owner && !owner.includes("$")) ghcrOwners.push(owner.toLowerCase());
            continue;
          }
          report({
            path: destination.path,
            line: destination.line,
            key: destination.key,
            message: `${destination.via} pushes \`${destination.ref}\` to ${registryName(host)} instead of GitHub Container Registry.`,
            suggestion: SUGGESTION(imageName(destination.ref)),
          });
        }
        if (unknownPushes === 0) continue;
        if (logins.some((login) => login.host === GHCR)) pushesToGhcr = true;
        if (known.length > 0) continue;
        for (const login of logins) {
          if (login.host === GHCR || LOCAL_HOST.test(login.host)) continue;
          report({
            path: login.entry.path,
            line: login.line,
            key: login.key,
            message: `Job \`${job.id}\` pushes images after logging in to ${registryName(login.host)} instead of GitHub Container Registry.`,
            suggestion: SUGGESTION("<image>"),
          });
        }
      }
    }

    if (!pushesToGhcr) return;
    const owner = ghcrOwners.sort()[0] ?? "<org>";
    for (const model of project.dockerfiles) {
      for (const stage of model.stages) {
        if (isInternalBase(model, stage) || !isDockerHub(registryHost(stage.image))) continue;
        const reference = `${stage.image}${stage.tag ? `:${stage.tag}` : ""}${stage.digest ? `@${stage.digest}` : ""}`;
        const name = stage.image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io|registry\.hub\.docker\.com)\//, "").replace(/^library\//, "");
        const mirror = `ghcr.io/${owner}/${name}${stage.tag ? `:${stage.tag}` : ""}`;
        report({
          path: model.path,
          line: stage.line,
          key: `stage:${stageLabel(stage)}:from-docker-hub`,
          message: `Base image \`${reference}\` is pulled from Docker Hub although this repository publishes its images to GHCR; Docker Hub rate-limits pulls and every build depends on a second registry.`,
          suggestion: `Mirror the base image to GHCR once (for example a scheduled workflow running \`docker buildx imagetools create -t ${mirror} ${reference}\`) and use \`FROM ${mirror}@sha256:<digest>\`, so builds pull from the same registry they push to.`,
        });
      }
    }
  },
});
