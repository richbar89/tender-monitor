import { Link } from "wouter";
import { Activity, Search, Database } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <span className="font-bold text-sm tracking-widest text-primary uppercase">TENDER TRACKER</span>
          </div>
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors font-medium">Dashboard</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
}
