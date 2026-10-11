import {
  initiateDeviceFlow,
  pollDeviceToken,
  fetchAccountProfile,
  DEFAULT_GATEWAY_URL,
} from "../../auth/oauth-client.js";
import { addOrUpdateToken } from "../../auth/token-store.js";

export interface LoginCommandOptions {
  readonly gatewayUrl?: string | undefined;
}

export async function runLoginCommand(options: LoginCommandOptions = {}): Promise<void> {
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;

  console.log("\n==================================================");
  console.log("       Omnirush2API - Device OAuth Login          ");
  console.log("==================================================\n");
  console.log(`[Omnirush2API] Connecting to gateway: ${gatewayUrl}`);

  try {
    const authSession = await initiateDeviceFlow({ gatewayUrl });

    console.log("\n1. Open the following verification URL in your browser:\n");
    console.log(`   ${authSession.verification_uri_complete}\n`);
    console.log(`2. Verify the code matches: [ ${authSession.user_code} ]\n`);
    console.log("3. Click 'Authorize' in your browser.\n");
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

    console.log("\n✓ Authorization approved by browser!");

    // Query profile info
    let email: string | undefined;
    if (tokenResult.accessToken) {
      const profile = await fetchAccountProfile(tokenResult.accessToken, gatewayUrl);
      if (profile) {
        email = profile.email;
        console.log(`✓ Account connected: ${profile.email ?? profile.id} (${profile.status})`);
        if (profile.usage?.remaining_tokens !== undefined) {
          console.log(`✓ Tokens remaining: ${profile.usage.remaining_tokens.toLocaleString()}`);
        }
      }
    }

    await addOrUpdateToken({
      refreshToken: tokenResult.refreshToken,
      accessToken: tokenResult.accessToken,
      gatewayUrl,
      email,
    });

    console.log("✓ Refresh token securely saved to ~/.omnirush2api/tokens.json\n");
    console.log("You can now start the daemon using: omnirush2api start\n");
  } catch (err) {
    console.error(`\n❌ Error during login: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
