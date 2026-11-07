import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupApiError } from "@/lib/transport";
import type { SetupState } from "@/lib/types";
import { fakeTransport, makeState } from "./fixtures";
import { mount, panel, pressInDialog } from "./mount";

const RUN = { id: 42, url: "https://github.com/acme/widgets/actions/runs/42" };
const TOKEN = "github_pat_example_0123456789";
const SAVE_TOKEN = "Validate and save assignment token";

const installation = (status: SetupState["installation"]["status"], run: SetupState["installation"]["run"] = null): Partial<SetupState> => ({
  installation: { status, run },
});

// A transport whose server already agrees with what is on screen, so an action cannot flip the page.
function mountAt(state: SetupState, kind: "http" | "mcp" = "http") {
  const transport = fakeTransport({ kind, state });
  return { transport, ...mount(transport, state) };
}

describe("register step", () => {
  it("posts the manifest straight to GitHub from the browser page", () => {
    mountAt(makeState("register"));

    const form = panel("register").querySelector("form");
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "https://github.com/organizations/acme/settings/apps/new?state=nonce");
    expect(form?.querySelector<HTMLInputElement>('input[name="manifest"]')).toHaveValue('{"name":"ci-cd-optimizer-acme"}');
    expect(within(panel("register")).getByRole("button", { name: "Review registration on GitHub" })).toHaveAttribute("type", "submit");
    expect(within(panel("register")).queryByRole("link", { name: /registration page/ })).not.toBeInTheDocument();
  });

  it("opens the registration page in a new tab from a chat host, where the page cannot post a form itself", () => {
    mountAt(makeState("register"), "mcp");

    const section = panel("register");
    expect(section.querySelector("form")).toBeNull();
    const link = within(section).getByRole("link", { name: /Open the registration page/ });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:4000/register?session=session-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("explains the permissions and the resume option", () => {
    mountAt(makeState("register"));

    const section = panel("register");
    expect(section).toHaveTextContent("GitHub will ask you to approve a private App owned by acme.");
    expect(section).toHaveTextContent("It requests no account-wide user permissions.");
    expect(section).toHaveTextContent("Already saved an App? Restart with --resume-app YOUR-APP-SLUG instead of registering another.");
  });

  it("offers no way to register when the snapshot has neither a form nor a link", () => {
    const state = makeState("register");
    mountAt(makeState("register", { registration: null, urls: { ...state.urls, register: null } }));

    const section = panel("register");
    expect(section.querySelector("form")).toBeNull();
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("credentials step", () => {
  it("explains where the key goes and asks before saving it", async () => {
    const { transport, user } = mountAt(makeState("credentials"));
    const section = panel("credentials");
    expect(section).toHaveTextContent("never printed, written to disk, or returned to this page");
    expect(section).toHaveTextContent("Saving writes or replaces CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID in acme/widgets.");

    await user.click(within(section).getByRole("button", { name: "Save credentials to this repository" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save the App credentials?" });
    expect(dialog).toHaveTextContent("The key goes straight to GitHub through the gh CLI on your machine.");
    expect(transport.act).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(transport.act).toHaveBeenCalledExactlyOnceWith("save-credentials", undefined));
  });
});

describe("install step", () => {
  it("links to the App's installation page and tells the user to come back", () => {
    mountAt(makeState("install"));

    const section = panel("install");
    expect(section).toHaveTextContent("Choose Only select repositories and select acme/widgets.");
    expect(within(section).getByRole("link", { name: /Install on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/apps/ci-cd-optimizer-acme/installations/new",
    );
    expect(section).toHaveTextContent("After installing, return to this setup tab and press Verify installation.");
  });

  it("says view instead of tab inside a chat host", () => {
    mountAt(makeState("install"), "mcp");

    expect(panel("install")).toHaveTextContent("return to this setup view and press Verify installation.");
  });

  it("offers one verification button and nothing about a run that has not started", () => {
    mountAt(makeState("install"));

    const section = panel("install");
    expect(within(section).getByRole("button", { name: "Verify installation" })).toBeEnabled();
    expect(within(section).queryByRole("button", { name: "Check verification result" })).not.toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: /View verification run/ })).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent("Verification runs in this repository");
  });

  it("explains that a resumed setup verifies in Actions", () => {
    mountAt(makeState("install", { resumed: true }));

    expect(panel("install")).toHaveTextContent("Verification runs in this repository's GitHub Actions using the saved key.");
  });

  it.each([
    [false, /mints a short-lived token for acme\/widgets/],
    [true, /starts the manual verification workflow in acme\/widgets/],
  ])("describes what verification does when resumed is %s", async (resumed, description) => {
    const { user } = mountAt(makeState("install", { resumed }));

    await user.click(screen.getByRole("button", { name: "Verify installation" }));

    expect(await screen.findByRole("alertdialog", { name: "Verify the installation?" })).toHaveTextContent(description);
  });

  it("shows a running verification as running and lets the user check on it without a confirmation", async () => {
    const { transport, user } = mountAt(makeState("install", installation("running", RUN)));
    const section = panel("install");

    expect(within(section).getByText(/^Verification is running\./)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Verify installation" })).toBeDisabled();
    expect(within(section).getByRole("link", { name: /View verification run/ })).toHaveAttribute("href", RUN.url);

    await user.click(within(section).getByRole("button", { name: "Check verification result" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(transport.act).toHaveBeenCalledExactlyOnceWith("check-verification", undefined);
  });

  it("shows why a verification failed and lets the user try again", () => {
    mountAt(
      makeState("install", {
        ...installation("failed", RUN),
        error: { step: "install", message: "The App is installed on all repositories. Choose only selected repositories." },
      }),
    );
    const section = panel("install");

    expect(within(section).getByRole("alert")).toHaveTextContent("Verification failed");
    expect(within(section).getByRole("alert")).toHaveTextContent("The App is installed on all repositories.");
    expect(within(section).getByRole("button", { name: "Verify again" })).toBeEnabled();
    expect(within(section).queryByRole("button", { name: "Verify installation" })).not.toBeInTheDocument();
  });

  it("keeps verification repeatable once it has passed", async () => {
    const { transport, user } = mountAt(makeState("authorize", installation("verified", RUN)));
    await user.click(screen.getByRole("button", { name: "Go to step 3: Install and verify" }));
    const section = panel("install");

    expect(section).toHaveTextContent("Installation and repository-scoped token verified.");
    expect(within(section).getByRole("link", { name: /View verification run/ })).toHaveAttribute("href", RUN.url);

    await user.click(within(section).getByRole("button", { name: "Verify again" }));
    await pressInDialog(user, "Verify");

    await waitFor(() => expect(transport.act).toHaveBeenCalledExactlyOnceWith("verify", undefined));
  });
});

describe("authorize step", () => {
  it("links to the scoped-token page and says a queue label is not a running agent", () => {
    mountAt(makeState("authorize"));

    const section = panel("authorize");
    expect(within(section).getByRole("link", { name: /Create a scoped assignment token on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(section).toHaveTextContent("Not authorized yet: copilot:ready is a queue label, not a running agent.");
    expect(section).toHaveTextContent("limited to acme/widgets with Issues: read and write, and an expiry");
  });

  describe("on the local page", () => {
    it("takes the token only in a password field that password managers leave alone", () => {
      mountAt(makeState("authorize"));

      const input = within(panel("authorize")).getByLabelText("Assignment token");
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveAttribute("autocomplete", "off");
      expect(input).toHaveAttribute("data-1p-ignore");
      expect(input).toHaveAttribute("data-lpignore", "true");
      expect(input).toHaveAccessibleDescription(/Never paste the token into chat\./);
    });

    it("keeps saving disabled until there is a token to check", async () => {
      const { user } = mountAt(makeState("authorize"));
      const input = screen.getByLabelText("Assignment token");
      const save = screen.getByRole("button", { name: SAVE_TOKEN });
      expect(save).toBeDisabled();

      await user.type(input, "   ");
      expect(save).toBeDisabled();

      await user.type(input, TOKEN);
      expect(save).toBeEnabled();
    });

    it("sends the token only after a confirmation that never shows it, then clears the field", async () => {
      const { transport, user } = mountAt(makeState("authorize"));
      const input = screen.getByLabelText("Assignment token");

      await user.type(input, TOKEN);
      expect(document.body).not.toHaveTextContent(TOKEN);
      await user.click(screen.getByRole("button", { name: SAVE_TOKEN }));

      const dialog = await screen.findByRole("alertdialog", { name: "Save the assignment token?" });
      expect(dialog).toHaveTextContent("saved as the Actions secret COPILOT_ASSIGN_TOKEN");
      expect(document.body).not.toHaveTextContent(TOKEN);
      expect(transport.act).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "Validate and save" }));

      await waitFor(() => expect(transport.act).toHaveBeenCalledExactlyOnceWith("authorize-copilot", { token: TOKEN }));
      await waitFor(() => expect(input).toHaveValue(""));
    });

    it("keeps the token when saving fails so the user can correct it, and says why on the step", async () => {
      const failed = makeState("authorize", { error: { step: "authorize", message: "Enter a valid user token." } });
      const { transport, user } = mountAt(makeState("authorize"));
      transport.act.mockRejectedValue(new SetupApiError("Enter a valid user token.", 400, failed));
      const input = screen.getByLabelText("Assignment token");

      await user.type(input, TOKEN);
      await user.click(screen.getByRole("button", { name: SAVE_TOKEN }));
      await pressInDialog(user, "Validate and save");

      const alert = await within(panel("authorize")).findByRole("alert");
      expect(alert).toHaveTextContent("Could not authorize the coding agent");
      expect(alert).toHaveTextContent("Enter a valid user token.");
      expect(input).toHaveValue(TOKEN);
      expect(screen.getByRole("button", { name: SAVE_TOKEN })).toBeEnabled();
    });

    it("asks for confirmation when Enter is pressed with a token, and does nothing without one", async () => {
      const { transport, user } = mountAt(makeState("authorize"));
      const input = screen.getByLabelText("Assignment token");

      await user.type(input, "{Enter}");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      await user.type(input, `${TOKEN}{Enter}`);
      expect(await screen.findByRole("alertdialog", { name: "Save the assignment token?" })).toBeInTheDocument();
      expect(transport.act).not.toHaveBeenCalled();
    });
  });

  describe("inside a chat host", () => {
    it("never offers a place to type the token, and sends the user to the local page", () => {
      mountAt(makeState("authorize"), "mcp");

      const section = panel("authorize");
      expect(section.querySelector("input")).toBeNull();
      expect(within(section).queryByRole("button", { name: SAVE_TOKEN })).not.toBeInTheDocument();
      expect(section).toHaveTextContent("For your security the token is entered only on the local setup page, never in chat.");
      expect(within(section).getByRole("link", { name: /Open the secure setup page/ })).toHaveAttribute("href", "http://127.0.0.1:4000/?session=session-1");
    });
  });
});

describe("scan step", () => {
  it("warns about what a scan can change, then asks before running it", async () => {
    const { transport, user } = mountAt(makeState("scan"));
    const section = panel("scan");
    expect(section).toHaveTextContent("including configured issue and pull request writes and coding-agent assignments");

    await user.click(within(section).getByRole("button", { name: "Run scan and assign pending findings" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Run the scan now?" });
    expect(dialog).toHaveTextContent("cicd-optimizer-scan.yml");
    expect(transport.act).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Run scan" }));
    await waitFor(() => expect(transport.act).toHaveBeenCalledExactlyOnceWith("run-scan", undefined));
  });

  it("does not claim an agent was assigned once the scan is requested", () => {
    mountAt(makeState(null));

    const section = panel("scan");
    expect(section).toHaveTextContent("A dispatch alone does not prove an agent was assigned");
    expect(within(section).getByRole("link", { name: /Open Actions/ })).toHaveAttribute("href", "https://github.com/acme/widgets/actions");
    expect(within(section).getByRole("button", { name: "Run again" })).toBeEnabled();
  });
});
