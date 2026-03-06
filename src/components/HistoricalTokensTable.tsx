import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
export interface HistoricalToken {
  mint: string;
  name?: string;
  symbol?: string;
  logoUri?: string;
}

interface HistoricalTokensTableProps {
  tokens: HistoricalToken[];
  loading: boolean;
}

function truncMint(mint: string): string {
  return `${mint.slice(0, 3)}...${mint.slice(-3)}`;
}

const TH =
  "font-mono text-[8px] uppercase tracking-wider text-muted-foreground";

export function HistoricalTokensTable({
  tokens,
  loading,
}: HistoricalTokensTableProps) {
  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-2">
        <div className="space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          No former tokens found
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow className="border-border hover:bg-transparent [&>th]:py-0.5 [&>th]:px-1.5">
            <TableHead className={TH}>Former Token</TableHead>
            <TableHead className={TH}>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((t, i) => (
            <TableRow
              key={t.mint}
              className="table-row-reveal border-border [&>td]:py-0.5 [&>td]:px-1.5"
              style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
            >
              <TableCell>
                <span className="font-mono text-[10px] text-foreground">
                  {t.symbol ?? truncMint(t.mint)}
                </span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-[9px] text-muted-foreground truncate max-w-[200px] block">
                  {t.name ?? truncMint(t.mint)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
