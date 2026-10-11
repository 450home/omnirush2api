import {
  loadStoredTokens,
  addOrUpdateToken,
  removeToken,
} from "../../auth/token-store.js";

export async function runTokensCommand(subcommand?: string, arg?: string): Promise<void> {
  const op = subcommand?.toLowerCase() ?? "list";

  if (op === "list") {
    const tokens = await loadStoredTokens();
    console.log(`\nStored Tokens in ~/.omnirush2api/tokens.json (${tokens.length}):\n`);
    if (tokens.length === 0) {
      console.log("  (No stored tokens found. Run 'omnirush2api login' to add one.)\n");
      return;
    }

    tokens.forEach((t, i) => {
      console.log(`  [${i + 1}] Refresh Token:`);
      console.log(`      ${t.refreshToken}`);
      if (t.email) console.log(`      Email:         ${t.email}`);
      if (t.gatewayUrl) console.log(`      Gateway:       ${t.gatewayUrl}`);
      console.log("");
    });
    return;
  }

  if (op === "add") {
    if (!arg || arg.trim() === "") {
      console.error("❌ Error: Missing refresh token argument. Usage: omnirush2api tokens add <token>");
      process.exitCode = 1;
      return;
    }
    await addOrUpdateToken({ refreshToken: arg.trim() });
    console.log("✓ Refresh token added to store.");
    return;
  }

  if (op === "remove") {
    if (!arg || arg.trim() === "") {
      console.error("❌ Error: Missing refresh token argument. Usage: omnirush2api tokens remove <token>");
      process.exitCode = 1;
      return;
    }
    const removed = await removeToken(arg.trim());
    if (removed) {
      console.log("✓ Refresh token removed from store.");
    } else {
      console.log("⚠️  Token not found in store.");
    }
    return;
  }

  console.error(`Unknown subcommand: ${op}. Available: list, add, remove`);
  process.exitCode = 1;
}
