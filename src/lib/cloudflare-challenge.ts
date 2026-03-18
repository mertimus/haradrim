let challengeRedirectStarted = false;

type ChallengeResponseLike = {
  status: number;
  headers: Pick<Headers, "get">;
  url?: string;
};

type ChallengeNavigator = (href: string) => void;

let challengeNavigator: ChallengeNavigator = (href) => {
  window.location.replace(href);
};

function isProtectedApiUrl(requestUrl?: string): boolean {
  if (typeof window === "undefined" || !requestUrl) return false;
  try {
    const parsed = new URL(requestUrl, window.location.href);
    return parsed.origin === window.location.origin
      && (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"));
  } catch {
    return false;
  }
}

export function isCloudflareChallengeResponse(
  response: ChallengeResponseLike,
  requestUrl?: string,
): boolean {
  if (!isProtectedApiUrl(requestUrl ?? response.url)) return false;

  const mitigated = response.headers.get("cf-mitigated")?.toLowerCase();
  if (mitigated === "challenge") return true;

  const status = Number(response.status);
  if (status !== 401 && status !== 403 && status !== 429) return false;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) return false;

  const server = response.headers.get("server")?.toLowerCase() ?? "";
  const cfRay = response.headers.get("cf-ray");
  return server.includes("cloudflare") || Boolean(cfRay);
}

export function maybeRedirectForCloudflareChallenge(
  response: ChallengeResponseLike,
  requestUrl?: string,
): boolean {
  if (!isCloudflareChallengeResponse(response, requestUrl)) return false;
  if (typeof window === "undefined") return false;

  if (!challengeRedirectStarted) {
    challengeRedirectStarted = true;
    challengeNavigator(window.location.href);
  }
  return true;
}

export function waitForCloudflareChallengeNavigation<T = never>(): Promise<T> {
  return new Promise<T>(() => {});
}

export const cloudflareChallengeTestUtils = {
  reset(): void {
    challengeRedirectStarted = false;
    challengeNavigator = (href: string) => {
      window.location.replace(href);
    };
  },
  setNavigator(navigator: ChallengeNavigator): void {
    challengeNavigator = navigator;
  },
};
