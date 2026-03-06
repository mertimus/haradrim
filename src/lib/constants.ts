export const LAMPORTS_PER_SOL = 1_000_000_000;

function getAppOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined)?.trim() ?? "http://localhost:5173";
}

export const APP_ORIGIN = getAppOrigin();
export const API_BASE_URL = `${APP_ORIGIN}/api`;
export const HELIUS_RPC_URL = `${API_BASE_URL}/helius-rpc`;
export const HELIUS_WALLET_API_BASE = `${API_BASE_URL}/helius-api/v1/wallet`;
export const BIRDEYE_API_BASE = `${API_BASE_URL}/birdeye-api`;
