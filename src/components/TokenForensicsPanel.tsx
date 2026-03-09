import { useMemo } from "react";
import type { ForensicEvidenceEdge, SuspiciousCluster } from "@/lib/suspicious-clusters";
import type { TokenForensicsReport } from "@/lib/backend-api";

function fmtPct(value: number): string {
  if (value >= 0.01) return `${value.toFixed(2)}%`;
  return "<0.01%";
}

function fmtAmount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(3);
}

function truncAddr(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function clusterSeverity(riskScore: number): string {
  if (riskScore >= 10) return "high";
  if (riskScore >= 6) return "medium";
  return "low";
}

function clusterGloss(label: string): string {
  switch (label) {
    case "Controller-Linked Cluster":
    case "Controller-Linked Distribution":
      return "Shared fee payers/signers suggest common control.";
    case "Shared-Funding Bundle":
      return "Holders share upstream funding and entered close together.";
    case "Shared-Source Bundle":
      return "Holders acquired directly from the same wallet in a tight window.";
    case "Launch Coordination":
      return "Holders entered in a narrow first-acquisition window.";
    case "Direct Distribution Ring":
      return "Holders share a direct source wallet for the token.";
    case "Wash-Like Trading":
      return "Linked holders churned the token through the same venue with low net position change.";
    case "Transfer Ring":
      return "Two-way internal transfers suggest circular inventory movement.";
    case "Distributor Ring":
      return "Internal transfers suggest staged distribution across wallets.";
    case "Shared Funding Ring":
      return "Holders share upstream funding ancestry.";
    default:
      return "Multiple weak-to-medium signals overlap across these wallets.";
  }
}

function holderLabel(
  address: string,
  labelMap: Map<string, string>,
): string {
  return labelMap.get(address) || truncAddr(address);
}

function clusterEdges(
  cluster: SuspiciousCluster | null,
  edges: ForensicEvidenceEdge[],
): ForensicEvidenceEdge[] {
  if (!cluster) return [];
  const members = new Set(cluster.members);
  return edges
    .filter((edge) => members.has(edge.source) && members.has(edge.target))
    .sort((a, b) => b.totalScore - a.totalScore || a.source.localeCompare(b.source));
}

interface TokenForensicsPanelProps {
  report: TokenForensicsReport | null;
  loading: boolean;
  error: string | null;
  selectedClusterId: number | null;
  onSelectCluster: (clusterId: number | null) => void;
}

export function TokenForensicsPanel({
  report,
  loading,
  error,
  selectedClusterId,
  onSelectCluster,
}: TokenForensicsPanelProps) {
  const labelMap = useMemo(
    () => new Map((report?.analyzedHolders ?? [])
      .filter((holder) => holder.label)
      .map((holder) => [holder.address, holder.label ?? ""])),
    [report],
  );

  const selectedCluster = useMemo(
    () => (
      selectedClusterId == null
        ? null
        : report?.clusters.find((cluster) => cluster.id === selectedClusterId) ?? null
    ),
    [report, selectedClusterId],
  );

  const selectedEdges = useMemo(
    () => clusterEdges(selectedCluster, report?.edges ?? []),
    [report?.edges, selectedCluster],
  );

  const topEdges = useMemo(
    () => [...(report?.edges ?? [])].sort((a, b) => b.totalScore - a.totalScore || a.source.localeCompare(b.source)).slice(0, 5),
    [report?.edges],
  );

  if (!loading && !error && !report) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden border-b border-border">
      <div className="border-b border-border px-2 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Token Forensics
          </span>
          {report && (
            <span className="font-mono text-[9px] text-muted-foreground">
              analyzed top {report.scopeLimit}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && (
          <p className="font-mono text-[10px] text-primary">
            Building controller, funding, entry, and trading evidence...
          </p>
        )}

        {!loading && error && (
          <p className="font-mono text-[10px] text-destructive">
            {error}
          </p>
        )}

        {!loading && !error && report && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[10px] text-foreground">
                  {report.summary.clusterCount} cluster{report.summary.clusterCount === 1 ? "" : "s"}
                </div>
                <div className="font-mono text-[9px] text-muted-foreground">
                  {report.summary.implicatedWalletCount} wallet{report.summary.implicatedWalletCount === 1 ? "" : "s"}
                  {" · "}
                  {fmtPct(report.summary.implicatedSupplyPct)}
                </div>
              </div>
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[10px] text-foreground">
                  {report.summary.visibleEdgeCount} evidence edge{report.summary.visibleEdgeCount === 1 ? "" : "s"}
                </div>
                <div className="font-mono text-[9px] text-muted-foreground">
                  {report.summary.washLikeClusters} wash-like cluster{report.summary.washLikeClusters === 1 ? "" : "s"}
                </div>
              </div>
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[9px] text-muted-foreground">Controller-linked pairs</div>
                <div className="font-mono text-[10px] text-foreground">
                  {report.summary.controllerLinkedPairs.toLocaleString()}
                </div>
              </div>
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[9px] text-muted-foreground">Funding / source pairs</div>
                <div className="font-mono text-[10px] text-foreground">
                  {(report.summary.fundingLinkedPairs + report.summary.directDistributionPairs).toLocaleString()}
                </div>
              </div>
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[9px] text-muted-foreground">Coordinated entry pairs</div>
                <div className="font-mono text-[10px] text-foreground">
                  {report.summary.coordinatedEntryPairs.toLocaleString()}
                </div>
              </div>
              <div className="rounded border border-border bg-card/60 px-2 py-1.5">
                <div className="font-mono text-[9px] text-muted-foreground">Snapshot</div>
                <div className="font-mono text-[10px] text-foreground">
                  {new Date(report.snapshotAt).toLocaleTimeString()}
                </div>
              </div>
            </div>

            {report.clusters.length === 0 ? (
              <div className="space-y-2 rounded border border-border bg-card/60 px-2 py-2">
                <p className="font-mono text-[10px] text-muted-foreground">
                  No cluster cleared the current threshold. Strongest pairwise evidence is shown below.
                </p>
                {topEdges.length === 0 && (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    No pairwise evidence cleared the visibility threshold.
                  </p>
                )}
                {topEdges.map((edge) => (
                  <div key={`${edge.source}-${edge.target}`} className="rounded border border-border/60 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-primary">
                        {holderLabel(edge.source, labelMap)}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground">↔</span>
                      <span className="font-mono text-[10px] text-primary">
                        {holderLabel(edge.target, labelMap)}
                      </span>
                      <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                        score {edge.totalScore.toFixed(1)}
                      </span>
                    </div>
                    {edge.summaryLines.slice(1, 3).map((line) => (
                      <div key={line} className="font-mono text-[9px] text-muted-foreground">
                        {line}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    Clusters
                  </div>
                  {report.clusters.map((cluster) => {
                    const selected = selectedCluster?.id === cluster.id;
                    return (
                      <button
                        key={cluster.id}
                        type="button"
                        onClick={() => onSelectCluster(selected ? null : cluster.id)}
                        className={`w-full rounded border px-2 py-1.5 text-left transition-colors ${
                          selected
                            ? "border-primary/40 bg-primary/10"
                            : "border-border bg-card/60 hover:border-primary/20 hover:bg-card/80"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-primary">
                            {cluster.label}
                          </span>
                          <span className="font-mono text-[9px] text-muted-foreground">
                            {clusterSeverity(cluster.riskScore)}
                          </span>
                          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                            risk {cluster.riskScore.toFixed(1)}
                          </span>
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          {cluster.members.length} wallets
                          {" · "}
                          {fmtPct(cluster.totalPct)}
                          {" of supply"}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          {clusterGloss(cluster.label)}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {selectedCluster && (
                  <div className="space-y-2 rounded border border-border bg-card/60 px-2 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-primary">
                        {selectedCluster.label}
                      </span>
                      <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                        risk {selectedCluster.riskScore.toFixed(1)}
                      </span>
                    </div>
                    <div className="font-mono text-[9px] text-muted-foreground">
                      {clusterGloss(selectedCluster.label)}
                    </div>

                    <div className="flex flex-wrap gap-1">
                      <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                        {selectedCluster.members.length} wallets
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                        {fmtPct(selectedCluster.totalPct)} supply
                      </span>
                      {selectedCluster.sharedControlPairs ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          {selectedCluster.sharedControlPairs} controller pairs
                        </span>
                      ) : null}
                      {selectedCluster.sharedFundingPairs ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          {selectedCluster.sharedFundingPairs} funding pairs
                        </span>
                      ) : null}
                      {selectedCluster.sharedTokenSourcePairs ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          {selectedCluster.sharedTokenSourcePairs} direct-source pairs
                        </span>
                      ) : null}
                      {selectedCluster.synchronizedPairs ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          {selectedCluster.synchronizedPairs} entry pairs
                        </span>
                      ) : null}
                      {selectedCluster.directTransferEdges ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          {selectedCluster.directTransferEdges} transfer edges
                        </span>
                      ) : null}
                      {selectedCluster.churnRatio ? (
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                          churn {selectedCluster.churnRatio.toFixed(1)}x
                        </span>
                      ) : null}
                    </div>

                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        Members
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {selectedCluster.members.map((member) => (
                          <span
                            key={member}
                            className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground"
                          >
                            {holderLabel(member, labelMap)}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        Why it was flagged
                      </div>
                      <div className="mt-1 space-y-1">
                        {selectedCluster.reasons.map((reason) => (
                          <div key={reason} className="font-mono text-[9px] text-muted-foreground">
                            {reason}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        Strongest pairs
                      </div>
                      <div className="mt-1 space-y-1">
                        {selectedEdges.slice(0, 5).map((edge) => (
                          <div
                            key={`${edge.source}-${edge.target}`}
                            className="rounded border border-border/60 px-2 py-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[10px] text-primary">
                                {holderLabel(edge.source, labelMap)}
                              </span>
                              <span className="font-mono text-[9px] text-muted-foreground">↔</span>
                              <span className="font-mono text-[10px] text-primary">
                                {holderLabel(edge.target, labelMap)}
                              </span>
                              <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                                {edge.totalScore.toFixed(1)}
                              </span>
                            </div>
                            {edge.summaryLines.slice(1, 4).map((line) => (
                              <div key={line} className="font-mono text-[9px] text-muted-foreground">
                                {line}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>

                    {(selectedCluster.grossTradeUiAmount ?? 0) > 0 && (
                      <div className="rounded border border-border/60 px-2 py-1.5">
                        <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                          Trading Profile
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          Gross target-mint venue flow: {fmtAmount(selectedCluster.grossTradeUiAmount ?? 0)}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          Net target-mint position change: {fmtAmount(selectedCluster.netTradeUiAmount ?? 0)}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          Shared venues: {selectedCluster.sharedTradingVenueCount ?? 0}
                          {" · "}
                          Two-way wallets: {selectedCluster.twoWayTradeWallets ?? 0}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="rounded border border-border bg-card/60 px-2 py-1.5">
              {report.warnings.map((warning) => (
                <div
                  key={warning}
                  className="font-mono text-[9px] text-muted-foreground"
                >
                  {warning}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
