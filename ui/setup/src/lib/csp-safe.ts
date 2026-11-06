import { config } from "zod/v4/core";

// The host serves this view without 'unsafe-eval'. Zod probes `new Function` unless told not to, and a browser reports that probe as a CSP violation even though the throw is caught.
// Import this module before anything that builds a schema, so the setting is in place first.
config({ jitless: true });
