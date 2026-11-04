import { parseImageReference } from "../../parsers/dockerfile.js";

export interface ImagePinProblem {
  kind: "digest" | "untagged" | "latest";
  message: string;
  suggestion: string;
}

/** Checks a literal image reference for a mutable tag (none or `latest`), or for a missing digest when required. */
export function imagePinProblem(reference: string, requireDigest: boolean, subject: string): ImagePinProblem | undefined {
  const { tag, digest } = parseImageReference(reference);
  if (digest?.toLowerCase().startsWith("sha256:")) return undefined;
  if (requireDigest) {
    return {
      kind: "digest",
      message: `${subject} \`${reference}\` is not pinned to an \`@sha256:\` digest, so its contents can change without a commit.`,
      suggestion: "Pin by digest while keeping the tag for readability (`name:1.2.3@sha256:<digest>`); Dependabot and Renovate can keep digests up to date.",
    };
  }
  if (digest) return undefined;
  if (tag === undefined || tag.toLowerCase() === "latest") {
    return {
      kind: tag === undefined ? "untagged" : "latest",
      message:
        tag === undefined
          ? `${subject} \`${reference}\` has no tag, so it resolves to the mutable \`latest\`.`
          : `${subject} \`${reference}\` uses the mutable \`latest\` tag.`,
      suggestion: "Pin a specific version tag (e.g. `name:1.2.3`), or a digest for full reproducibility.",
    };
  }
  return undefined;
}
