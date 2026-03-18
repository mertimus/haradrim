import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudflareChallengeTestUtils,
  isCloudflareChallengeResponse,
  maybeRedirectForCloudflareChallenge,
} from "@/lib/cloudflare-challenge";

describe("cloudflare challenge handling", () => {
  afterEach(() => {
    cloudflareChallengeTestUtils.reset();
  });

  it("detects Cloudflare challenge responses on same-origin api routes", () => {
    const response = {
      status: 403,
      headers: new Headers({
        "cf-mitigated": "challenge",
        "content-type": "text/html; charset=UTF-8",
      }),
      url: `${window.location.origin}/api/healthz`,
    };

    expect(isCloudflareChallengeResponse(response)).toBe(true);
  });

  it("ignores html 403s from non-api origins", () => {
    const response = {
      status: 403,
      headers: new Headers({
        "content-type": "text/html; charset=UTF-8",
      }),
      url: "https://api.helius.xyz/v0/transactions",
    };

    expect(isCloudflareChallengeResponse(response)).toBe(false);
  });

  it("redirects only once when the challenge cookie expires", () => {
    const replace = vi.fn();
    cloudflareChallengeTestUtils.setNavigator(replace);

    const response = {
      status: 403,
      headers: new Headers({
        "cf-mitigated": "challenge",
      }),
      url: `${window.location.origin}/api/traces/test/flows`,
    };

    expect(maybeRedirectForCloudflareChallenge(response)).toBe(true);
    expect(maybeRedirectForCloudflareChallenge(response)).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(window.location.href);
  });
});
