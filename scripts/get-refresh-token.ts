import { runLoginCommand } from "../src/cli/commands/login.js";

async function main(): Promise<void> {
  console.log("\n========================================================");
  console.log("   omnirush2api - Device OAuth Login & Token Retriever  ");
  console.log("========================================================\n");

  // Always initiate an interactive OAuth login flow to obtain a fresh token
  await runLoginCommand({ openBrowser: true });
}

main().catch((err) => {
  console.error("❌ Fatal error during login:", err);
  process.exit(1);
});
