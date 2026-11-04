import { gzipSync } from "node:zlib";
import { httpStatus, type GitHubClient, type RepoRef } from "./client.js";

export type SarifUploadResult = { status: "uploaded"; id?: string } | { status: "unavailable"; reason: string };

/**
 * Uploads SARIF to code scanning so findings appear as alerts next to CodeQL (GitHub Advanced Security parity).
 * Repositories without code scanning (private repos without GHAS) reject the upload; that is not an error for us.
 */
export async function uploadSarif(
  client: GitHubClient,
  repo: RepoRef,
  options: { sarif: string | object; commitSha: string; ref: string; toolName?: string },
): Promise<SarifUploadResult> {
  const text = typeof options.sarif === "string" ? options.sarif : JSON.stringify(options.sarif);
  try {
    const response = await client.request("POST /repos/{owner}/{repo}/code-scanning/sarifs", {
      ...repo,
      commit_sha: options.commitSha,
      ref: options.ref.startsWith("refs/") ? options.ref : `refs/heads/${options.ref}`,
      sarif: gzipSync(Buffer.from(text, "utf8")).toString("base64"),
      tool_name: options.toolName ?? "CI/CD Optimizer",
    });
    const id = (response.data as { id?: string } | undefined)?.id;
    return id ? { status: "uploaded", id } : { status: "uploaded" };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 403 || status === 404) {
      return { status: "unavailable", reason: "Code scanning is not enabled for this repository (requires GitHub Advanced Security for private repositories)." };
    }
    if (status === 413) return { status: "unavailable", reason: "SARIF payload exceeds the code scanning size limit." };
    throw error;
  }
}
