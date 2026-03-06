import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WalletProfile } from "../../src/components/WalletProfile";

describe("WalletProfile", () => {
  it("shows explicit unavailable states for failed profile sections", () => {
    render(
      <WalletProfile
        address="86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY"
        identity={null}
        balances={null}
        funding={null}
        loading={false}
        identityFailed
        balancesFailed
        fundingFailed
      />,
    );

    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });
});
