import { useParams } from "wouter";
import { useGetTender, getGetTenderQueryKey, useProcessTenderPdf } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { formatCurrency, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PdfStatusBadge } from "@/components/tender-list";
import { ArrowLeft, Building2, Calendar, FileText, PoundSterling, ExternalLink, Activity, Users, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";

export default function TenderDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const [isPolling, setIsPolling] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: tender, isLoading } = useGetTender(id, {
    query: {
      enabled: !!id,
      queryKey: getGetTenderQueryKey(id),
      refetchInterval: isPolling ? 5000 : false,
    }
  });

  useEffect(() => {
    if (tender) {
      setIsPolling(tender.pdfStatus === "downloading");
    }
  }, [tender]);

  const processMutation = useProcessTenderPdf({
    mutation: {
      onSuccess: () => {
        toast({ title: "PDF Processing Started" });
        queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(id) });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to process PDF" });
      }
    }
  });

  const handleProcess = () => {
    processMutation.mutate({ id });
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="container mx-auto px-4 py-8 max-w-5xl">
          <Skeleton className="h-8 w-24 mb-6 bg-card" />
          <Skeleton className="h-40 w-full mb-8 bg-card" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <Skeleton className="h-96 w-full md:col-span-2 bg-card" />
            <Skeleton className="h-96 w-full bg-card" />
          </div>
        </div>
      </Layout>
    );
  }

  if (!tender) {
    return (
      <Layout>
        <div className="container mx-auto px-4 py-12 text-center">
          <h2 className="text-xl font-bold text-foreground">Tender not found</h2>
          <Link href="/" className="text-primary hover:underline mt-4 inline-block">Return to dashboard</Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="container mx-auto px-4 py-6 max-w-6xl">
        <Link href="/" className="inline-flex items-center text-sm font-mono text-muted-foreground hover:text-primary transition-colors mb-6 uppercase tracking-wider">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Results
        </Link>

        {/* Header Header */}
        <div className="bg-card border border-border p-6 mb-6">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Badge variant="secondary" className="rounded-none bg-muted font-mono text-xs uppercase text-muted-foreground">{tender.noticeId}</Badge>
            <Badge variant="outline" className="rounded-none border-primary text-primary font-mono text-xs uppercase">{tender.procurementStage}</Badge>
            <PdfStatusBadge status={tender.pdfStatus} />
          </div>
          
          <h1 className="text-2xl md:text-3xl font-bold text-foreground leading-tight mb-6 max-w-4xl">
            {tender.title}
          </h1>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-6 border-t border-border">
            <div className="space-y-1">
              <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase flex items-center gap-1.5"><Building2 className="w-3 h-3"/> Buyer</span>
              <p className="text-sm font-medium">{tender.buyerName || "Unknown"}</p>
            </div>
            <div className="space-y-1">
              <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase flex items-center gap-1.5"><PoundSterling className="w-3 h-3"/> Value</span>
              <p className="text-sm font-mono text-primary font-bold">{formatCurrency(tender.awardedValue, tender.currency || "GBP")}</p>
            </div>
            <div className="space-y-1">
              <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase flex items-center gap-1.5"><Calendar className="w-3 h-3"/> Published</span>
              <p className="text-sm font-mono">{formatDate(tender.publishedDate)}</p>
            </div>
            <div className="space-y-1">
              <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase flex items-center gap-1.5"><ExternalLink className="w-3 h-3"/> Source</span>
              <a href={tender.noticeUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-primary hover:underline flex items-center">
                View on FTS <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-card border border-border p-6">
              <h3 className="text-sm font-bold tracking-widest text-foreground uppercase mb-4 flex items-center gap-2 border-b border-border pb-2">
                <FileText className="w-4 h-4 text-primary" />
                Description
              </h3>
              <div className="prose prose-invert max-w-none text-sm text-muted-foreground">
                {tender.description ? (
                  <p className="whitespace-pre-wrap">{tender.description}</p>
                ) : (
                  <p className="italic opacity-50">No description provided.</p>
                )}
              </div>
            </div>

            {tender.rawPdfText && (
              <div className="bg-card border border-border p-6">
                <h3 className="text-sm font-bold tracking-widest text-foreground uppercase mb-4 flex items-center gap-2 border-b border-border pb-2">
                  <Activity className="w-4 h-4 text-primary" />
                  PDF Extracted Text
                </h3>
                <div className="bg-background border border-border p-4 h-96 overflow-y-auto font-mono text-xs text-muted-foreground leading-relaxed">
                  <pre className="whitespace-pre-wrap">{tender.rawPdfText}</pre>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="bg-card border border-border p-6">
              <div className="flex items-center justify-between border-b border-border pb-2 mb-4">
                <h3 className="text-sm font-bold tracking-widest text-foreground uppercase flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" />
                  Intelligence
                </h3>
              </div>
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-mono text-muted-foreground uppercase">Unsuccessful Suppliers</h4>
                    <Badge variant="outline" className="rounded-none border-border font-mono text-[10px]">
                      {tender.unsuccessfulSuppliers?.length || 0}
                    </Badge>
                  </div>
                  
                  {tender.unsuccessfulSuppliers && tender.unsuccessfulSuppliers.length > 0 ? (
                    <ul className="space-y-2">
                      {tender.unsuccessfulSuppliers.map((supplier, i) => (
                        <li key={i} className="bg-background border border-border p-2.5 text-sm font-medium flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                          {supplier}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="bg-background border border-border border-dashed p-4 text-center">
                      <p className="text-xs text-muted-foreground font-mono">
                        {tender.pdfStatus === "processed" 
                          ? "No unsuccessful suppliers identified in the document." 
                          : "Process the PDF to extract supplier intelligence."}
                      </p>
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-border">
                  <h4 className="text-xs font-mono text-muted-foreground uppercase mb-3">Document Processing</h4>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Status</span>
                      <PdfStatusBadge status={tender.pdfStatus} />
                    </div>
                    {tender.pdfUrl && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Source PDF</span>
                        <a href={tender.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                          Download <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                    <Button 
                      className="w-full rounded-none bg-primary hover:bg-primary/90 text-primary-foreground font-bold tracking-wider uppercase mt-2"
                      onClick={handleProcess}
                      disabled={processMutation.isPending || tender.pdfStatus === "downloading" || tender.pdfStatus === "processed"}
                    >
                      {tender.pdfStatus === "downloading" || processMutation.isPending ? "Processing..." : "Extract Data"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
