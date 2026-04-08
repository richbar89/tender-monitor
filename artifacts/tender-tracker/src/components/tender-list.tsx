import { useListTenders, getListTendersQueryKey, useProcessTenderPdf } from "@workspace/api-client-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, ArrowRight, AlertCircle, Building2, Calendar, PoundSterling, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";

export function PdfStatusBadge({ status }: { status: string }) {
  const statusStyles: Record<string, string> = {
    none: "bg-muted text-muted-foreground border-transparent",
    downloading: "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
    downloaded: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    processed: "bg-green-500/20 text-green-400 border-green-500/30",
    failed: "bg-destructive/20 text-destructive border-destructive/30",
  };

  return (
    <Badge variant="outline" className={`rounded-sm font-mono text-[10px] uppercase px-1.5 py-0 ${statusStyles[status] || statusStyles.none}`}>
      {status}
    </Badge>
  );
}

export function TenderList() {
  const [isPolling, setIsPolling] = useState(false);
  const queryClient = useQueryClient();
  
  const { data: listResponse, isLoading } = useListTenders(
    { limit: 50 },
    {
      query: {
        queryKey: getListTendersQueryKey({ limit: 50 }),
        refetchInterval: isPolling ? 5000 : false,
      }
    }
  );

  useEffect(() => {
    if (listResponse?.tenders) {
      const hasDownloading = listResponse.tenders.some(t => t.pdfStatus === "downloading");
      setIsPolling(hasDownloading);
    }
  }, [listResponse]);

  const { toast } = useToast();
  
  const processMutation = useProcessTenderPdf({
    mutation: {
      onSuccess: () => {
        toast({ title: "PDF Processing Started" });
        queryClient.invalidateQueries({ queryKey: getListTendersQueryKey({ limit: 50 }) });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to process PDF" });
      }
    }
  });

  const handleProcess = (id: number) => {
    processMutation.mutate({ id });
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-32 w-full bg-card rounded-none border border-border" />
        ))}
      </div>
    );
  }

  if (!listResponse?.tenders || listResponse.tenders.length === 0) {
    return (
      <div className="bg-card border border-border border-dashed p-12 flex flex-col items-center justify-center text-center space-y-4 h-[400px]">
        <Search className="w-12 h-12 text-muted-foreground opacity-50" />
        <div className="space-y-1">
          <h3 className="text-lg font-bold text-foreground">No Tenders Found</h3>
          <p className="text-sm text-muted-foreground max-w-md">
            Your database is currently empty. Run a search using the parameters on the left to discover high-value framework contracts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-4 border-b border-border pb-2">
        <h2 className="text-sm font-bold tracking-widest text-foreground uppercase">Results ({listResponse.total})</h2>
      </div>
      
      <div className="flex flex-col gap-3">
        {listResponse.tenders.map((tender) => (
          <div key={tender.id} className="bg-card border border-border group hover:border-primary/50 transition-colors p-4 flex flex-col sm:flex-row gap-4 relative">
            <div className="flex-1 space-y-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="rounded-none bg-muted font-mono text-[10px] uppercase text-muted-foreground">{tender.noticeId}</Badge>
                  <PdfStatusBadge status={tender.pdfStatus} />
                  {tender.unsuccessfulSuppliers?.length > 0 && (
                    <Badge className="bg-primary/20 text-primary border-primary/30 rounded-none font-mono text-[10px]">
                      {tender.unsuccessfulSuppliers.length} SUPPLIERS FOUND
                    </Badge>
                  )}
                </div>
                <Link href={`/tenders/${tender.id}`} className="text-base font-semibold text-foreground hover:text-primary transition-colors line-clamp-2 leading-tight">
                  {tender.title}
                </Link>
              </div>
              
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground font-mono">
                <div className="flex items-center gap-1.5">
                  <Building2 className="w-3 h-3 text-primary" />
                  <span className="truncate max-w-[200px]">{tender.buyerName || "Unknown Buyer"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <PoundSterling className="w-3 h-3 text-primary" />
                  <span>{formatCurrency(tender.awardedValue, tender.currency || "GBP")}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 text-primary" />
                  <span>{formatDate(tender.publishedDate)}</span>
                </div>
              </div>
            </div>
            
            <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-3 border-t sm:border-t-0 sm:border-l border-border pt-4 sm:pt-0 sm:pl-4 sm:w-32">
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full rounded-none border-border bg-background hover:bg-muted font-mono text-xs"
                onClick={() => handleProcess(tender.id)}
                disabled={processMutation.isPending || tender.pdfStatus === "downloading" || tender.pdfStatus === "processed"}
              >
                {tender.pdfStatus === "downloading" ? (
                  <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                ) : (
                  <FileText className="w-3 h-3 mr-2 text-primary" />
                )}
                PROCESS
              </Button>
              <Link href={`/tenders/${tender.id}`} className="w-full">
                <Button variant="ghost" size="sm" className="w-full rounded-none hover:text-primary group-hover:text-primary transition-colors font-mono text-xs">
                  DETAILS <ArrowRight className="w-3 h-3 ml-2" />
                </Button>
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
