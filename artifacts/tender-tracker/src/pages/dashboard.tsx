import { Layout } from "@/components/layout";
import { useGetTenderStats, getGetTenderStatsQueryKey } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { TenderSearch } from "@/components/tender-search";
import { TenderList } from "@/components/tender-list";

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

export default function Dashboard() {
  return (
    <Layout>
      <div className="container mx-auto px-4 py-6 max-w-7xl">
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
