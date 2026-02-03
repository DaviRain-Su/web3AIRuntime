import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import yaml from "js-yaml";

export type RiskLevel = "low" | "med" | "high";

export type UserProfile = {
  id: string;
  riskLevel: RiskLevel;
  maxSlippageBps: number;
  allowedProtocols: string[];
  requireConfirmOnFallback: boolean;
};

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

export function loadUserProfile(w3rtDir?: string): UserProfile {
  const dir = w3rtDir ?? defaultW3rtDir();
  const id = process.env.W3RT_PROFILE || "default";
  const p = join(dir, "profiles", `${id}.yaml`);

  try {
    const raw = readFileSync(p, "utf-8");
    const j = (yaml.load(raw) as any) ?? {};

    const riskLevel: RiskLevel = (j.riskLevel === "high" || j.riskLevel === "med" || j.riskLevel === "low")
      ? j.riskLevel
      : "low";

    const maxSlippageBps = Number(j.maxSlippageBps ?? 100);

    const allowedProtocols = Array.isArray(j.allowedProtocols)
      ? j.allowedProtocols.map(String)
      : [];

    const requireConfirmOnFallback = j.requireConfirmOnFallback !== false;

    return {
      id,
      riskLevel,
      maxSlippageBps: Number.isFinite(maxSlippageBps) ? maxSlippageBps : 100,
      allowedProtocols,
      requireConfirmOnFallback,
    };
  } catch {
    // Safe defaults
    return {
      id,
      riskLevel: "low",
      maxSlippageBps: 100,
      allowedProtocols: ["jupiter", "meteora", "solend"],
      requireConfirmOnFallback: true,
    };
  }
}
