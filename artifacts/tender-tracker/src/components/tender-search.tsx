import { useState } from "react";
import { useSearchTenders, getListTendersQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STAGES = ["award", "contract", "awarded", "contracted", "tender"];

export function TenderSearch() {
  const [keyword, setKeyword] = useState("Framework");
  const [minValue, setMinValue] = useState("5000000");
  const [selectedStages, setSelectedStages] = useState<string[]>(["award", "contract", "awarded", "contracted"]);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const searchMutation = useSearchTenders({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Search Complete",
          description: `Found ${data.tendersFound} tenders.`,
        });
        queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Search Failed",
          description: "An error occurred while running the search.",
        });
      }
    }
  });

  const handleSearch = () => {
    searchMutation.mutate({
      data: {
        keyword,
        minValue: minValue ? parseInt(minValue, 10) : null,
        stages: selectedStages,
      }
    });
  };

  const toggleStage = (stage: string) => {
    setSelectedStages(prev => 
      prev.includes(stage) 
        ? prev.filter(s => s !== stage)
        : [...prev, stage]
    );
  };

  return (
    <div className="bg-card border border-border p-4 rounded-none flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Search className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-widest text-foreground uppercase">Search Parameters</h2>
      </div>
      
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="keyword" className="text-xs font-mono text-muted-foreground uppercase">Keyword</Label>
          <Input 
            id="keyword" 
            value={keyword} 
            onChange={(e) => setKeyword(e.target.value)} 
            className="rounded-none bg-background font-mono text-sm border-border focus-visible:ring-primary focus-visible:border-primary"
          />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="minValue" className="text-xs font-mono text-muted-foreground uppercase">Min Value (£)</Label>
          <Input 
            id="minValue" 
            type="number"
            value={minValue} 
            onChange={(e) => setMinValue(e.target.value)} 
            className="rounded-none bg-background font-mono text-sm border-border focus-visible:ring-primary focus-visible:border-primary"
          />
        </div>
        
        <div className="space-y-3">
          <Label className="text-xs font-mono text-muted-foreground uppercase">Procurement Stages</Label>
          <div className="flex flex-col gap-2">
            {STAGES.map(stage => (
              <div key={stage} className="flex items-center space-x-2">
                <Checkbox 
                  id={`stage-${stage}`} 
                  checked={selectedStages.includes(stage)}
                  onCheckedChange={() => toggleStage(stage)}
                  className="rounded-none border-border data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                />
                <label 
                  htmlFor={`stage-${stage}`} 
                  className="text-sm font-mono cursor-pointer"
                >
                  {stage}
                </label>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      <Button 
        onClick={handleSearch} 
        disabled={searchMutation.isPending}
        className="w-full rounded-none bg-primary hover:bg-primary/90 text-primary-foreground font-bold tracking-wider uppercase mt-4"
      >
        {searchMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Running Search...
          </>
        ) : (
          "Run Search"
        )}
      </Button>
    </div>
  );
}
