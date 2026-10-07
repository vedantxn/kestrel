import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The microVM template build (runtime/microvm/build-template.sh) needs the host to run; what it
 * does to files the running VMs share is checked here. A template's kernel is hard-linked into
 * every clone's jail: a new one must be renamed into place, never written into the old file.
 */
const MICROVM = resolve(
  fileURLToPath(import.meta.url),
  "../../../../runtime/microvm",
);
const install = (src: string, dst: string) =>
  execFileSync("bash", [join(MICROVM, "install-file.sh"), src, dst]);

describe("installing a file the VMs link", () => {
  it("renames new content into place, leaving the old file, and every link to it, as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    writeFileSync(join(dir, "src"), "kernel 2");
    writeFileSync(join(dir, "vmlinux"), "kernel 1");
    // a running VM's jail links the old kernel
    linkSync(join(dir, "vmlinux"), join(dir, "jail-vmlinux"));
    const before = statSync(join(dir, "vmlinux")).ino;
    install(join(dir, "src"), join(dir, "vmlinux"));
    expect(readFileSync(join(dir, "vmlinux"), "utf8")).toBe("kernel 2");
    expect(readFileSync(join(dir, "jail-vmlinux"), "utf8")).toBe("kernel 1");
    expect(statSync(join(dir, "vmlinux")).ino).not.toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["jail-vmlinux", "src", "vmlinux"]);
  });

  it("does nothing when the file already has the content", () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    writeFileSync(join(dir, "src"), "kernel 1");
    writeFileSync(join(dir, "vmlinux"), "kernel 1");
    const before = statSync(join(dir, "vmlinux")).ino;
    install(join(dir, "src"), join(dir, "vmlinux"));
    expect(statSync(join(dir, "vmlinux")).ino).toBe(before);
  });

  it("is how the template build puts the kernel in place, and it never copies onto it", () => {
    const script = readFileSync(join(MICROVM, "build-template.sh"), "utf8");
    expect(script).toContain(
      '"$(dirname "$0")/install-file.sh" "$FC/vmlinux" "$DIR/vmlinux"',
    );
    expect(script).not.toMatch(/cp [^\n]*"\$DIR\/vmlinux"/);
  });
});
