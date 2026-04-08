import { useState } from "react";
import { Layout } from "@/components/layout";
import { useGetTenderStats, getGetTenderStatsQueryKey } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TenderSearch } from "@/components/tender-search";
import { TenderList } from "@/components/tender-list";
import { RefreshCw, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

function StatsBar() {
  const { data: stats, isLoading } = useGetTenderStats({
    query: {
      queryKey: getGetTenderStatsQueryKey()
    }
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-20 w-full bg-card rounded-none border border-border" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border mb-6 border border-border">
      <StatBox label="TOTAL MONITORED" value={stats.total.toLocaleString()} />
      <StatBox label="W/ UNSUCCESSFUL SUPPLIERS" value={stats.withUnsuccessfulSuppliers.toLocaleString()} />
      <StatBox label="TOTAL PDF PROCESSED" value={stats.totalPdfProcessed.toLocaleString()} />
      <StatBox label="AVG VALUE" value={formatCurrency(stats.averageValue)} />
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-card p-4 flex flex-col gap-1">
      <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase">{label}</span>
      <span className="text-xl font-bold text-foreground font-mono">{value}</span>
    </div>
  );
}

function ForcePullButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleForcePull() {
    setStatus("loading");
    try {
      await fetch("/api/tenders/run-now", { method: "POST" });
      setStatus("done");
      setTimeout(() => setStatus("idle"), 4000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 4000);
    }
  }

  return (
    <Button
      onClick={handleForcePull}
      disabled={status === "loading"}
      variant="outline"
      size="sm"
      className="font-mono text-xs tracking-wider uppercase gap-2"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${status === "loading" ? "animate-spin" : ""}`} />
      {status === "loading" ? "Running..." : status === "done" ? "Job Started" : status === "error" ? "Error" : "Force Pull"}
    </Button>
  );
}

function ClearDatabaseButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [confirm, setConfirm] = useState(false);
  const queryClient = useQueryClient();

  async function handleClear() {
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    setStatus("loading");
    try {
      await fetch("/api/tenders", { method: "DELETE" });
      await queryClient.invalidateQueries();
      setStatus("done");
      setTimeout(() => setStatus("idle"), 3000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <Button
      onClick={handleClear}
      disabled={status === "loading"}
      variant="outline"
      size="sm"
      className={`font-mono text-xs tracking-wider uppercase gap-2 ${confirm ? "border-destructive text-destructive hover:bg-destructive/10" : ""}`}
    >
      <Trash2 className="w-3.5 h-3.5" />
      {status === "loading" ? "Clearing..." : status === "done" ? "Cleared" : confirm ? "Confirm?" : "Clear DB"}
    </Button>
  );
}

export default function Dashboard() {
  return (
    <Layout>
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Framework Contract Awards</h1>
          <div className="flex items-center gap-2">
            <ClearDatabaseButton />
            <ForcePullButton />
          </div>
        </div>
        <StatsBar />
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-1">
            <TenderSearch />
          </div>
          <div className="lg:col-span-3">
            <TenderList />
          </div>
        </div>
      </div>
    </Layout>
  );
}
