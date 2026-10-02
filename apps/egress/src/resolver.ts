import { Resolver as DnsResolver } from "node:dns/promises";

/** Name resolution, as an interface so tests can supply answers. IPv4 only: sessions have no IPv6 (N7). */
export interface Resolver {
  resolve4(name: string): Promise<string[]>;
}

export class DnsResolve implements Resolver {
  private r = new DnsResolver({ timeout: 3000, tries: 2 });

  async resolve4(name: string): Promise<string[]> {
    try {
      return await this.r.resolve4(name);
    } catch {
      return [];
    }
  }
}
