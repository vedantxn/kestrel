"use client";

import {
  Activity,
  BarChart3,
  ChevronsUpDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Server,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { Logo } from "@kestrel/dashboard/components/logo";
import { Button } from "@kestrel/dashboard/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@kestrel/dashboard/components/ui/dropdown-menu";
import { Separator } from "@kestrel/dashboard/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@kestrel/dashboard/components/ui/sidebar";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Matches only the exact path, not its children. */
  exact?: boolean;
}

export function dashboardNav(base: string, admin: boolean): NavItem[][] {
  const main: NavItem[] = [
    { href: base, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${base}/sessions`, label: "Sessions", icon: Activity },
    { href: `${base}/usage`, label: "Usage", icon: BarChart3 },
  ];
  const manage: NavItem[] = [
    { href: `${base}/api-keys`, label: "API keys", icon: KeyRound },
    { href: `${base}/settings`, label: "Settings", icon: Settings },
  ];
  if (admin)
    manage.push({ href: `${base}/nodes`, label: "Nodes", icon: Server });
  return [main, manage];
}

export function Shell({
  children,
  project,
  org,
  admin,
  signOut,
  base = "/dashboard",
  extraNav = [],
}: {
  children: ReactNode;
  project: string;
  org: string;
  admin: boolean;
  /** A server action. */
  signOut: () => Promise<void>;
  base?: string;
  /** Items an app adds to the "Manage" group (the hosted app's members page). */
  extraNav?: NavItem[];
}) {
  const pathname = usePathname();
  const [main, manage] = dashboardNav(base, admin);
  const groups: [string, NavItem[]][] = [
    ["Platform", main!],
    ["Manage", [...manage!, ...extraNav]],
  ];
  const active = (item: NavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const current = groups.flatMap(([, items]) => items).find((i) => active(i));

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href={base}>
                  <Logo />
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map(([label, items]) => (
            <SidebarGroup key={label}>
              <SidebarGroupLabel>{label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active(item)}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold uppercase">
                      {project.slice(0, 2)}
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{project}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {org}
                        {admin ? " · admin" : ""}
                      </span>
                    </span>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Signed in to {project}
                  </DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href={`${base}/settings`}>
                      <Settings /> Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <form action={signOut}>
                    <DropdownMenuItem asChild>
                      <button type="submit" className="w-full">
                        <LogOut /> Sign out
                      </button>
                    </DropdownMenuItem>
                  </form>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 !h-4" />
          <span className="text-sm font-medium">{current?.label ?? ""}</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
