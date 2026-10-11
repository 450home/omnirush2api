import { findLocalCredentials } from "../src/auth/clicreds.js";
import { loadStoredTokens } from "../src/auth/token-store.js";
import { runLoginCommand } from "../src/cli/commands/login.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force") || process.argv.includes("-f");

  console.log("\n========================================================");
  console.log("   Omnirush2API - Automatic Refresh Token Retriever     ");
  console.log("========================================================\n");

  if (!force) {
    console.log("[1/2] Checking existing local credentials on this machine...");
    const [discovered, stored] = await Promise.all([
      findLocalCredentials(),
      loadStoredTokens(),
    ]);

    const allTokens = new Map<string, { source: string; email?: string | undefined }>();
    for (const d of discovered) {
      allTokens.set(d.refreshToken, { source: d.source, email: d.email });
    }
    for (const s of stored) {
      if (!allTokens.has(s.refreshToken)) {
        allTokens.set(s.refreshToken, { source: "~/.omnirush2api/tokens.json", email: s.email });
      }
    }

    if (allTokens.size > 0) {
      console.log(`\n✓ Found ${allTokens.size} existing token(s) locally:\n`);
      let i = 1;
      for (const [token, meta] of allTokens.entries()) {
        console.log(`--- [Token #${i}] ---`);
        console.log(`Source: ${meta.source}`);
        if (meta.email) console.log(`Email:  ${meta.email}`);
        console.log("Refresh Token (copy this for Cloudflare Workers secret OMNIRUSH_REFRESH_TOKEN):");
        console.log("--------------------------------------------------------------------------------");
        console.log(token);
        console.log("--------------------------------------------------------------------------------\n");
        i++;
      }

      console.log("Tip: To initiate a fresh OAuth login instead, run:");
      console.log("  npm run login -- --force\n");
      return;
    }

    console.log("No existing tokens found. Initiating browser OAuth login...\n");
  }

  // Initiate interactive OAuth login flow
  await runLoginCommand({ openBrowser: true });
}

main().catch((err) => {
  console.error("❌ Fatal error retrieving refresh token:", err);
  process.exit(1);
});
