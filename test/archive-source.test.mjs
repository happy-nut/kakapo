import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchiveEntry, splitArchivePath } from "../dist/archive-source.js";
import { readLibrarySourceFile } from "../dist/library-source.js";
import { buildPhar, PHAR_STUB } from "./helpers/phar.mjs";
import { buildZip } from "./helpers/zip.mjs";

const STUB = PHAR_STUB;

let dir;
function pharWith(entries, options) {
  dir ??= mkdtempSync(join(tmpdir(), "kakapo-phar-"));
  const path = join(dir, `a${Math.random().toString(36).slice(2)}.phar`);
  writeFileSync(path, buildPhar(entries, options));
  return path;
}
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const BIG = 1_000_000;

test("the archive and the entry are split off a phar path", () => {
  assert.deepEqual(splitArchivePath("/x/phpactor.phar/vendor/a/b.php"), { archive: "/x/phpactor.phar", entry: "vendor/a/b.php" });
  assert.deepEqual(splitArchivePath("C:\\x\\p.PHAR\\a.php"), { archive: "C:/x/p.PHAR", entry: "a.php" });
  assert.equal(splitArchivePath("/x/phpactor.phar"), null, "the archive itself is not an entry");
  assert.equal(splitArchivePath("/x/lib/a.php"), null, "an ordinary path names no archive");
  assert.deepEqual(splitArchivePath("/x/guava.jar!/com/A.class"), { archive: "/x/guava.jar", entry: "com/A.class" },
    "a jar is read too, since the Kotlin server answers library definitions with one");
  assert.equal(splitArchivePath("/x/guava.jar!/"), null, "an archive with no entry names nothing");
  assert.equal(splitArchivePath("/x/notes.txt!/a"), null, "only an archive extension opens this door");
  assert.equal(splitArchivePath(""), null);
});

test("a stored entry and a deflated entry both come back whole", () => {
  const long = `<?php\n${"// padding that compresses well\n".repeat(400)}echo 'end';\n`;
  const path = pharWith([
    { name: "first.php", data: "<?php echo 1;\n" },
    { name: "deep/date_c.php", data: long, deflate: true },
    { name: "last.php", data: "<?php echo 3;\n" },
  ]);
  assert.equal(readArchiveEntry(`${path}/first.php`, BIG).bytes.toString(), "<?php echo 1;\n");
  assert.equal(readArchiveEntry(`${path}/deep/date_c.php`, BIG).bytes.toString(), long);
  assert.equal(readArchiveEntry(`${path}/last.php`, BIG).bytes.toString(), "<?php echo 3;\n");
});

test("a phar entry opens as a read-only library source file", () => {
  const path = pharWith([{ name: "vendor/stubs/date_c.php", data: "<?php\nclass DateTime {}\n", deflate: true }]);
  const file = readLibrarySourceFile(`${path}/vendor/stubs/date_c.php`);
  assert.ok(file, "the entry is served even though the path is not a file");
  assert.equal(file.content, "<?php\nclass DateTime {}\n");
  assert.equal(file.language, "php", "named by the entry, not by the .phar");
  assert.equal(file.library, true);
  assert.equal(file.embedded, true);
  assert.ok(file.signature, "it has a signature, so the view can cache it");
});

test("everything it cannot read comes back null instead of throwing", () => {
  const path = pharWith([
    { name: "ok.php", data: "<?php echo 1;\n" },
    { name: "zipped.php", data: "<?php echo 2;\n", bzip2: true },
    { name: "lies.php", data: "<?php echo 3;\n", declaredSize: 99999 },
    { name: "binary.php", data: Buffer.from([0x3c, 0x3f, 0x00, 0x01, 0x02]) },
  ]);
  assert.equal(readArchiveEntry(`${path}/ok.php`, BIG).bytes.toString(), "<?php echo 1;\n", "the control entry reads");
  const cases = {
    "a name no entry has": `${path}/missing.php`,
    "the archive itself": path,
    "an archive that is not there": `${join(dir, "gone.phar")}/ok.php`,
    "a bzip2 entry": `${path}/zipped.php`,
    "an entry whose declared size is a lie": `${path}/lies.php`,
    "an entry past the size cap": `${path}/ok.php`,
  };
  for (const [what, target] of Object.entries(cases)) {
    const cap = what === "an entry past the size cap" ? 4 : BIG;
    assert.equal(readArchiveEntry(target, cap), null, what);
  }
  assert.equal(readLibrarySourceFile(`${path}/binary.php`), null, "a binary entry");

  const garbage = join(dir, "junk.phar");
  writeFileSync(garbage, Buffer.alloc(4096, 0x41));
  assert.equal(readArchiveEntry(`${garbage}/ok.php`, BIG), null, "a file that is not a phar at all");

  const cut = join(dir, "cut.phar");
  writeFileSync(cut, buildPhar([{ name: "ok.php", data: "<?php echo 1;\n" }]).subarray(0, STUB.length + 20));
  assert.equal(readArchiveEntry(`${cut}/ok.php`, BIG), null, "a truncated archive");

  const over = join(dir, "over.phar");
  writeFileSync(over, buildPhar([{ name: "ok.php", data: "<?php echo 1;\n" }], { manifestLength: 1 << 30 }));
  assert.equal(readArchiveEntry(`${over}/ok.php`, BIG), null, "a manifest longer than the archive");
});


function jarWith(entries) {
  dir ??= mkdtempSync(join(tmpdir(), "kakapo-phar-"));
  const path = join(dir, `a${Math.random().toString(36).slice(2)}.jar`);
  writeFileSync(path, buildZip(entries));
  return path;
}

test("one entry is read out of a jar, deflated or stored", () => {
  const jar = jarWith([
    { name: "com/one/First.class", bytes: Buffer.from("\xca\xfe\xba\xbefirst", "binary") },
    { name: "com/two/Second.class", bytes: Buffer.from("second payload that deflates well ".repeat(8)) },
    { name: "plain.txt", bytes: Buffer.from("stored"), deflate: false },
  ]);
  assert.equal(readArchiveEntry(`${jar}!/com/two/Second.class`, BIG).bytes.toString(),
    "second payload that deflates well ".repeat(8), "a deflated entry inflates to its declared size");
  assert.equal(readArchiveEntry(`${jar}!/plain.txt`, BIG).bytes.toString(), "stored", "a stored entry is copied");
  assert.equal(readArchiveEntry(`${jar}!/com/one/First.class`, BIG).bytes.subarray(0, 4).toString("hex"), "cafebabe",
    "and the entry asked for is the entry returned");
});

test("a jar answers nothing for what it does not hold", () => {
  const jar = jarWith([{ name: "com/one/First.class", bytes: Buffer.from("x") }]);
  assert.equal(readArchiveEntry(`${jar}!/com/one/Absent.class`, BIG), null, "an entry nobody put there");
  assert.equal(readArchiveEntry(`${jar}/com/one/First.class`, BIG), null, "a path with no !/ names no entry");
  assert.equal(readArchiveEntry(`${jar}!/com/one/First.class`, 0), null, "an entry over the caller's ceiling");
});
