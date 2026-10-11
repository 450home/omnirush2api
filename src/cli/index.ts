import { runStartCommand } from "./commands/start.js";
import { runLoginCommand } from "./commands/login.js";
import { runCheckCommand } from "./commands/check.js";
import { runTokensCommand } from "./commands/tokens.js";
import type { CliOptions } from "../types/config.js";

const VERSION = "1.0.0";

function printHelp(): void {
  console.log(`
Omnirush2API v${VERSION}
OAuth to OpenAI-compatible API router for Omnirush.ai

Usage:
  omnirush2api <command> [options]

Commands:
  start               Start the local OpenAI-compatible API daemon (default)
  login               Initiate interactive terminal OAuth device flow
  check               Inspect and verify local credentials & quota status
  tokens              Manage stored refresh tokens (list, add, remove)

Options:
  -p, --port <number> Specify port for the HTTP daemon (default: 20129)
  -h, --host <host>   Specify host address (default: 127.0.0.1)
  -k, --key <string>  Set required Bearer API key for incoming requests
  --gateway-url <url> Override upstream OmniRush gateway URL
  --token <tokens>    Specify one or more refresh tokens (comma-separated)
  -v, --version       Display version information
  --help              Display this help message

Examples:
  omnirush2api login
  omnirush2api check
  omnirush2api start --port 20129 --key sk-my-secret-key
`);
}

function parseArgs(args: string[]): { command: string; options: CliOptions; extraArgs: string[] } {
  let command = "start";
  const options: Record<string, unknown> = {};
  const extraArgs: string[] = [];

  const knownCommands = new Set(["start", "login", "check", "tokens"]);
  let i = 0;

  if (args.length > 0 && args[0] && knownCommands.has(args[0])) {
    command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "-p" || arg === "--port") {
      options["port"] = parseInt(args[++i] ?? "20129", 10);
    } else if (arg === "-h" || arg === "--host") {
      options["host"] = args[++i];
    } else if (arg === "-k" || arg === "--key") {
      options["key"] = args[++i];
    } else if (arg === "--gateway-url") {
      options["gatewayUrl"] = args[++i];
    } else if (arg === "--token") {
      options["token"] = args[++i];
    } else if (arg === "-v" || arg === "--version") {
      options["version"] = true;
    } else if (arg === "--help") {
      options["help"] = true;
    } else {
      extraArgs.push(arg);
    }
    i++;
  }

  return { command, options: options as CliOptions, extraArgs };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { command, options, extraArgs } = parseArgs(rawArgs);

  if (options.version) {
    console.log(`omnirush2api v${VERSION}`);
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  switch (command) {
    case "login":
      await runLoginCommand({ gatewayUrl: options.gatewayUrl });
      break;
    case "check":
      await runCheckCommand({ gatewayUrl: options.gatewayUrl });
      break;
    case "tokens":
      await runTokensCommand(extraArgs[0], extraArgs[1]);
      break;
    case "start":
    default:
      await runStartCommand(options);
      break;
  }
}

main().catch((err) => {
  console.error("[Omnirush2API] Fatal error:", err);
  process.exit(1);
});
