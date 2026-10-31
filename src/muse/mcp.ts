import { MuseHost, MspError } from "./host.ts";
import { mapMcpServers, type McpRow } from "./composer.ts";

export interface McpListOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: arguments placed before `serve`. */
  binaryArgs?: string[];
  clientVersion?: string;
}

/**
 * Lists the host's MCP servers (name, where configured, transport, OAuth state). `mcpServer/list` is
 * experimental, so, like the usage refresh, it uses a short-lived host of its own and leaves the chat host
 * on the stable surface. No session, no model call; the rows hold configuration facts only, never secrets.
 */
export async function listMcpServers(options: McpListOptions): Promise<McpRow[]> {
  const host = new MuseHost({
    binary: options.binary,
    args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"],
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  try {
    host.start();
    await host.request("initialize", {
      clientInfo: { name: "antares", version: options.clientVersion ?? "0.0.1" },
      capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false },
    });
    host.notify("initialized");
    return mapMcpServers(await host.request("mcpServer/list", {}, 20_000));
  } catch (error) {
    if (error instanceof MspError) throw new Error(`The host refused the connector list: ${error.message}`);
    throw error;
  } finally {
    await host.stop(3000);
  }
}
