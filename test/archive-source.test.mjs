// A definition target that is a path INTO a file, not a path to one. Phpactor ships PhpStorm's stubs inside
// its own `.phar`, so go-to-definition on `date()` answers
// `…/phpactor.phar/vendor/jetbrains/phpstorm-stubs/date/date_c.php` — real source behind a path `existsSync`
// denies. These pin the reader and, more importantly, every way it must refuse: the parser walks a manifest
// written by something else, and a misparse that returns bytes anyway would paint convincing garbage.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchiveEntry, splitArchivePath } from "../dist/archive-source.js";
import { readLibrarySourceFile } from "../dist/library-source.js";
import { buildPhar, PHAR_STUB } from "./helpers/phar.mjs";

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
  assert.equal(splitArchivePath("/x/guava.jar!/com/A.class"), null, "a jar is a zip — not read here, by design");
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
  // The one in the middle is the real test: an entry's offset is the sum of the COMPRESSED sizes before it,
  // so a reader that used uncompressed sizes still passes on the first entry and fails here.
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
  // The control: if this stops working, every "returns null" below starts passing for the wrong reason.
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
  // Binary bytes are refused by the library reader, which asks the same question as it does of a real file.
  assert.equal(readLibrarySourceFile(`${path}/binary.php`), null, "a binary entry");

  const garbage = join(dir, "junk.phar");
  writeFileSync(garbage, Buffer.alloc(4096, 0x41));
  assert.equal(readArchiveEntry(`${garbage}/ok.php`, BIG), null, "a file that is not a phar at all");

  // Truncation is the one that reaches the catch: the manifest declares entries the file no longer holds.
  const cut = join(dir, "cut.phar");
  writeFileSync(cut, buildPhar([{ name: "ok.php", data: "<?php echo 1;\n" }]).subarray(0, STUB.length + 20));
  assert.equal(readArchiveEntry(`${cut}/ok.php`, BIG), null, "a truncated archive");

  // A manifest that claims to be longer than the file, which is how a hostile archive would try to walk off
  // the end of the buffer.
  const over = join(dir, "over.phar");
  writeFileSync(over, buildPhar([{ name: "ok.php", data: "<?php echo 1;\n" }], { manifestLength: 1 << 30 }));
  assert.equal(readArchiveEntry(`${over}/ok.php`, BIG), null, "a manifest longer than the archive");
});

