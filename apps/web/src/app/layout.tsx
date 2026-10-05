import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "@kestrel/dashboard/components/ui/sonner";
import { TooltipProvider } from "@kestrel/dashboard/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kestrel", template: "%s · Kestrel" },
  description: "Cloud browsers for AI agents",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider
          attribute="class"
          storageKey="kestrel-theme"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
