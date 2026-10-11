import { findLocalCredentials } from "../../auth/clicreds.js";
import { loadStoredTokens } from "../../auth/token-store.js";
import {
  refreshDeviceToken,
  fetchAccountProfile,
  DEFAULT_GATEWAY_URL,
} from "../../auth/oauth-client.js";

export interface CheckCommandOptions {
  readonly gatewayUrl?: string | undefined;
}

export async function runCheckCommand(options: CheckCommandOptions = {}): Promise<void> {
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;

  console.log("\n[Omnirush2API] Checking local OmniRush credentials and status...\n");

  const [discovered, stored] = await Promise.all([
    findLocalCredentials(),
    loadStoredTokens(),
  ]);

  // Merge unique tokens
  const tokenMap = new Map<
    string,
    { source: string; gatewayUrl: string; email?: string | undefined }
  >();

  for (const item of discovered) {
    tokenMap.set(item.refreshToken, {
      source: item.source,
      gatewayUrl: item.gatewayUrl || gatewayUrl,
      email: item.email,
    });
  }

  for (const item of stored) {
    if (!tokenMap.has(item.refreshToken)) {
      tokenMap.set(item.refreshToken, {
        source: "~/.omnirush2api/tokens.json",
        gatewayUrl: item.gatewayUrl || gatewayUrl,
        email: item.email,
      });
    }
  }

  if (tokenMap.size === 0) {
    console.log("❌ No OmniRush credentials detected.");
    console.log("\nTo authenticate:");
    console.log("  1. Run: omnirush2api login");
    console.log("  2. Or set: export OMNIRUSH_REFRESH_TOKEN=\"your_refresh_token\"");
    console.log("  3. Or log into OmniRush Desktop app.\n");
    return;
  }

  console.log(`Found ${tokenMap.size} unique OmniRush credential(s):\n`);

  let index = 1;
  for (const [refreshToken, meta] of tokenMap.entries()) {
    console.log(`--- [Account #${index}] ---`);
    console.log(`  Source: ${meta.source}`);
    console.log(`  Token:  ${refreshToken.slice(0, 12)}... (${refreshToken.length} chars)`);

    // Verify token with refresh call
    const refreshRes = await refreshDeviceToken(refreshToken, {
      gatewayUrl: meta.gatewayUrl,
    });

    if (refreshRes.success && refreshRes.accessToken) {
      console.log("  Status: ✓ Active & verified");
      const profile = await fetchAccountProfile(refreshRes.accessToken, meta.gatewayUrl);
      if (profile) {
        console.log(`  Email:  ${profile.email ?? "Unknown"}`);
        console.log(`  Plan:   ${profile.status}`);
        if (profile.usage) {
          const u = profile.usage;
          if (u.remaining_tokens !== undefined) {
            console.log(`  Tokens Remaining: ${u.remaining_tokens.toLocaleString()}`);
          }
          if (u.day?.used !== undefined) {
            console.log(`  Today's Used:     ${u.day.used.toLocaleString()}`);
          }
        }
      }
    } else {
      console.log(`  Status: ❌ Refresh failed (${refreshRes.error ?? "Invalid token"})`);
    }
    console.log("");
    index++;
  }

  console.log("Local authentication check complete.\n");
}
