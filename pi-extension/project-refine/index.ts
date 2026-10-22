import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";

export function supportedPiVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return !!match && Number(match[1]) === 1 && Number(match[2]) >= 3;
}

/** No discovery, timers, model calls, or filesystem writes at extension load. */
export default function projectRefine(pi: ExtensionAPI): void {
  if (!supportedPiVersion(VERSION)) {
    pi.registerCommand("project-refine", {
      description: "Project Refine requires Pi >=1.3.0 <2",
      handler: async (_args, ctx) => { ctx.ui.notify(`Project Refine requires Pi >=1.3.0 <2; host is ${VERSION}.`, "error"); },
    });
    return;
  }
  registerCommands(pi);
}
