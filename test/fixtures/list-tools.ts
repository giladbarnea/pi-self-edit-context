// At session start, write the names of every tool Pi has registered to $LIST_TOOLS_FILE, since RPC mode has no command that lists tools.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", () => writeFileSync(process.env.LIST_TOOLS_FILE!, JSON.stringify(pi.getAllTools().map((tool) => tool.name))));
}
