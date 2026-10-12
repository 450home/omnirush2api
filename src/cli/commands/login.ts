import { exec } from "node:child_process";
import {
  initiateDeviceFlow,
  pollDeviceToken,
  fetchAccountProfile,
  DEFAULT_GATEWAY_URL,
} from "../../auth/oauth-client.js";
import { addOrUpdateToken } from "../../auth/token-store.js";

export interface LoginCommandOptions {
  readonly gatewayUrl?: string | undefined;
  readonly openBrowser?: boolean | undefined;
}

function launchBrowser(url: string): void {
  const platform = process.platform;
  let command = "";
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, () => {});
}

export async function runLoginCommand(options: LoginCommandOptions = {}): Promise<void> {
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;
  const shouldOpenBrowser = options.openBrowser ?? true;

  console.log("\n==================================================");
  console.log("       Omnirush2API - Device OAuth Login          ");
  console.log("==================================================\n");
  console.log(`[Omnirush2API] Connecting to gateway: ${gatewayUrl}`);

  try {
    const authSession = await initiateDeviceFlow({ gatewayUrl });

    console.log("\n1. Verification URL:\n");
    console.log(`   ${authSession.verification_uri_complete}\n`);
    console.log(`2. User Verification Code: [ ${authSession.user_code} ]\n`);

    if (shouldOpenBrowser) {
      console.log("-> Opening verification link in your default browser...");
      launchBrowser(authSession.verification_uri_complete);
    }

    console.log("\n3. Click 'Authorize' in your browser.");
    console.log(`Waiting for approval (expires in ${Math.round(authSession.expires_in / 60)} minutes)...`);

    const tokenResult = await pollDeviceToken(authSession.device_code, {
      gatewayUrl,
      intervalSeconds: authSession.interval || 5,
    });

    if (!tokenResult.success || !tokenResult.refreshToken) {
      console.error(`\n❌ Authorization failed: ${tokenResult.error ?? "Unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log("\n✓ Authorization approved by browser!\n");

    // Query profile info
    let email: string | undefined;
    let plan = "active";
    let remainingTokens: number | undefined;

    if (tokenResult.accessToken) {
      const profile = await fetchAccountProfile(tokenResult.accessToken, gatewayUrl);
      if (profile) {
        email = profile.email;
        plan = profile.status;
        remainingTokens = profile.usage?.remaining_tokens;
      }
    }

    await addOrUpdateToken({
      refreshToken: tokenResult.refreshToken,
      accessToken: tokenResult.accessToken,
      gatewayUrl,
      email,
    });

    console.log("================================================================================");
    console.log("🎉 Omnirush OAuth Login Successful!");
    console.log("================================================================================");
    console.log("\n[Option A: Cloudflare Worker Secret (Recommended Pair)]");
    console.log("Set OMNIRUSH_REFRESH_TOKEN to this pair to avoid cold start refresh invalidation:");
    console.log("--------------------------------------------------------------------------------");
    console.log(`${tokenResult.refreshToken}|${tokenResult.accessToken ?? ""}`);
    console.log("--------------------------------------------------------------------------------\n");
    console.log("[Option B: Separate Secrets / Local Daemon]");
    console.log(`• Refresh Token:  ${tokenResult.refreshToken}`);
    if (tokenResult.accessToken) {
      console.log(`• Access Token:   ${tokenResult.accessToken}`);
    }
    console.log("");
    if (email) console.log(`✓ Account:          ${email} (${plan})`);
    if (remainingTokens !== undefined) console.log(`✓ Tokens Remaining: ${remainingTokens.toLocaleString()}`);
    console.log("✓ Saved to Disk:    ~/.omnirush2api/tokens.json");
    console.log("\nNext Steps:");
    console.log("  • Local Daemon:       npm start  (auto-persists rotated tokens to disk)");
    console.log("  • Cloudflare Worker:  Paste Option A into OMNIRUSH_REFRESH_TOKEN secret");
    console.log("  • Worker KV Sync:     (Optional) Bind a KV namespace as TOKEN_KV for multi-region sync\n");
  } catch (err) {
    console.error(`\n❌ Error during login: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
