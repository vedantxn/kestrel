import { describe, expect, it } from "vitest";
import {
  compareClones,
  flatten,
  looksRandom,
  parseListing,
  type CloneObservation,
} from "./clones.js";

let n = 0;
const rnd = () => `${(n++).toString(16).padStart(8, "0")}${"ab".repeat(12)}`;

/** One session as `observe` sees it; every random value fresh. */
function obs(over: Partial<CloneObservation> = {}): CloneObservation {
  return {
    node: "a",
    sessionId: `ses_${n++}`,
    first: { math: [Math.random()], grv: rnd(), uuid: rnd() },
    page: {
      math: [Math.random(), Math.random()],
      grv: rnd(),
      uuid: rnd(),
      skewMs: 3,
      devices: ["", ""],
      cookie: "",
      localStorage: 0,
      caches: [],
      indexedDb: [],
      serviceWorkers: 0,
      constants: { userAgent: "Chrome/154", hardwareConcurrency: 1 },
    },
    connectionReused: false,
    cdp: { cookies: 0, browserContextIds: ["CTX1"], browserPid: 77 },
    files: {
      "Local State": { size: 900, digest: "d1" },
      "Default/Visited Links": { size: 131072, digest: "vl" },
      "Default/History": { size: 4096, digest: rnd() },
    },
    json: {
      "Local State#browser.enabled_labs_experiments": "",
      "Local State#user_experience_metrics.low_entropy_source3": "4123",
      "Local State#profile.created_by_version": "154.0.8037.92",
      "Default/Secure Preferences#protection.macs.homepage":
        "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6",
    },
    ...over,
  };
}
const rules = (d: ReturnType<typeof compareClones>) =>
  d.failures.map((f) => f.item);

describe("what a snapshot copies into every clone (G-24)", () => {
  it("passes two clones that share only the build and the allowed items", () => {
    const d = compareClones(obs(), obs());
    // No baseline: the entropy source is a small number, so there is no evidence it was generated.
    expect(d.failures).toEqual([]);
    expect(
      d.shared.find((s) => s.item === "cdp.browserContextIds"),
    ).toMatchObject({ verdict: "allowed" });
    expect(
      d.shared.find((s) => s.item.includes("protection.macs")),
    ).toMatchObject({ verdict: "allowed" });
  });

  it("fails on randomness a page can read that two clones share", () => {
    const a = obs();
    const b = obs();
    b.first.math = [...a.first.math];
    b.page.uuid = a.page.uuid;
    expect(rules(compareClones(a, b))).toEqual([
      "first.Math.random",
      "page.uuid",
    ]);
  });

  it("does not count a randomUUID the page could not make as shared (about:blank is not a secure context)", () => {
    const a = obs();
    const b = obs();
    a.first.uuid = "";
    b.first.uuid = "";
    expect(rules(compareClones(a, b))).toEqual([]);
    b.first.grv = a.first.grv; // the first page's crypto is still judged
    expect(rules(compareClones(a, b))).toEqual(["first.grv"]);
  });

  it("fails on a clock off the host's, shared device ids, template state and a copied connection", () => {
    const a = obs();
    const b = obs();
    a.page.skewMs = 3_600_000;
    b.page.devices = ["salted-id-1"];
    a.page.devices = ["salted-id-1"];
    b.page.localStorage = 2;
    b.connectionReused = true;
    expect(rules(compareClones(a, b)).sort()).toEqual(
      [
        `clock.${a.sessionId}`,
        "page.mediaDevices",
        `storage.${b.sessionId}`,
        `connection.${b.sessionId}`,
      ].sort(),
    );
  });

  it("with containers as a baseline, fails on identifiers the snapshot copied and lists the rest", () => {
    const a = obs();
    const b = obs();
    const c1 = obs();
    const c2 = obs();
    // Every container drew its own client id, entropy source and Visited Links salt; the clones
    // share theirs.
    for (const o of [a, b, c2])
      o.json["Local State#user_experience_metrics.client_id2"] = "id-template";
    c1.json["Local State#user_experience_metrics.client_id2"] = "id-container";
    c1.json["Local State#user_experience_metrics.low_entropy_source3"] = "17";
    c1.files["Default/Visited Links"] = { size: 131072, digest: "other" };
    // Created at template build in the clones, at launch in each container: copied, but not a secret.
    a.json["Local State#profile.creation_time"] = "13370000000000000";
    b.json["Local State#profile.creation_time"] = "13370000000000000";
    c1.json["Local State#profile.creation_time"] = "13370000000000001";
    const d = compareClones(a, b, [c1, c2]);
    expect(d.baseline).toBe(true);
    expect(rules(d).sort()).toEqual([
      "Local State#user_experience_metrics.client_id2",
      "file:Default/Visited Links",
    ]);
    // Copied too, but field-trial randomization with no field trials: listed as allowed, with why.
    expect(
      d.shared.find(
        (s) =>
          s.item === "Local State#user_experience_metrics.low_entropy_source3",
      ),
    ).toMatchObject({ verdict: "allowed" });
    expect(
      d.shared.find((s) => s.item === "Local State#profile.creation_time"),
    ).toMatchObject({ verdict: "copied" });
    expect(
      d.shared.find((s) => s.item === "Local State#profile.created_by_version"),
    ).toMatchObject({ verdict: "same-everywhere" });
  });

  it("without a baseline, fails on a generated-looking value two clones share", () => {
    const a = obs();
    const b = obs();
    a.json["Default/BrowsingTopicsState#hex_encoded_hmac_key"] =
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    b.json["Default/BrowsingTopicsState#hex_encoded_hmac_key"] =
      a.json["Default/BrowsingTopicsState#hex_encoded_hmac_key"]!;
    expect(rules(compareClones(a, b))).toEqual([
      "Default/BrowsingTopicsState#hex_encoded_hmac_key",
    ]);
  });
});

describe("reading the profile", () => {
  it("parses Chrome's directory listing", () => {
    const html = `<script>start("/profile/");</script>
<script>onHasParentDirectory();</script>
<script>addRow("..","..",1,0,"0 B",0,"");</script>
<script>addRow("Default","Default",1,4096,"4.0 kB",1759700000,"10/6/25");</script>
<script>addRow("Local State","Local%20State",0,1203,"1.2 kB",1759700000,"10/6/25");</script>
<script>addRow("a \\"q\\"","a",0,7,"7 B",1,"");</script>`;
    expect(parseListing(html)).toEqual([
      { name: "Default", dir: true, size: 4096 },
      { name: "Local State", dir: false, size: 1203 },
      { name: 'a "q"', dir: false, size: 7 },
    ]);
  });

  it("flattens JSON values, and tells generated strings from written ones", () => {
    expect(flatten("f", { a: { b: [1, "x"] }, c: null })).toEqual({
      "f#a.b.0": "1",
      "f#a.b.1": "x",
      "f#c": "null",
    });
    expect(looksRandom("9f86d081884c7d659a2feaa0c55ad015")).toBe(true);
    expect(looksRandom("Zm9vYmFyQmF6UXV4MTIzNDU2")).toBe(true);
    expect(looksRandom("13370000000000000")).toBe(false);
    expect(looksRandom("154.0.8037.92")).toBe(false);
    expect(looksRandom("https://example.com/")).toBe(false);
    expect(looksRandom("short1A")).toBe(false);
  });
});
