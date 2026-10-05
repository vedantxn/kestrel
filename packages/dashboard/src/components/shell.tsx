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
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { CommandMenu } from "@kestrel/dashboard/components/command-menu";
import { Logo } from "@kestrel/dashboard/components/logo";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@kestrel/dashboard/components/ui/breadcrumb";
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
import { shortId } from "@kestrel/dashboard/lib/format";

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
  /** Items an app adds to the "Manage" group. */
  extraNav?: NavItem[];
}) {
  const pathname = usePathname();
  const [main, manage] = dashboardNav(base, admin);
  const groups: [string, NavItem[]][] = [
    ["Platform", main!],
    ["Manage", [...manage!, ...extraNav]],
  ];
  const all = groups.flatMap(([, items]) => items);
  const active = (item: NavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const current = all.find((i) => active(i));
  // A third crumb for a page below a section: a session's id.
  const rest =
    current && !current.exact ? pathname.slice(current.href.length + 1) : "";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="pt-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                asChild
                className="hover:bg-transparent"
              >
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
                        className="relative data-[active=true]:font-medium"
                      >
                        <Link href={item.href}>
                          {active(item) && (
                            <motion.span
                              layoutId="nav-active"
                              className="absolute inset-y-0 -left-2 w-[3px] bg-brand"
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 40,
                              }}
                            />
                          )}
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
                  <SidebarMenuButton
                    size="lg"
                    className="border data-[state=open]:bg-sidebar-accent"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center bg-foreground font-mono text-[11px] font-medium text-background uppercase">
                      {project.slice(0, 2)}
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{project}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {org}
                      </span>
                    </span>
                    <ChevronsUpDown className="ml-auto size-4 opacity-60" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-60">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {project}
                    {admin ? " · admin" : ""}
                  </DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href={`${base}/settings`}>
                      <Settings /> Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`${base}/api-keys`}>
                      <KeyRound /> API keys
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
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="!h-4" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink asChild>
                  <Link href={base}>{project}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {current && (
                <>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    {rest ? (
                      <BreadcrumbLink asChild>
                        <Link href={current.href}>{current.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{current.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </>
              )}
              {rest && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="font-mono text-xs">
                      {shortId(decodeURIComponent(rest))}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden w-64 sm:block">
              <CommandMenu items={all} base={base} />
            </div>
            <ThemeToggle />
          </div>
        </header>
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 border-dashed p-4 md:p-8 xl:border-x"
        >
          {children}
        </motion.div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Theme"
        >
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
