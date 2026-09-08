import { AgentWorkspace } from "@/components/agent/AgentWorkspace";

export const metadata = {
  title: "Agent control room | mc-aws",
  description: "Admin agent operations workspace for the live Minecraft server.",
};

export default function AgentPage() {
  return <AgentWorkspace />;
}
