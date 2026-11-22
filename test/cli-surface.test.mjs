import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_COMMANDS, CLI_OPTIONS, CLI_INTERNAL_ARGS, cliValueOptions, commandsHelp, optionsHelp }
  from "../dist/cli-surface.js";

const root = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

// Two argument streams, and conflating them is what hid a dead option for a year. A user types the first;
// the CLI then builds the second and hands it to the app, so a flag the CLI always pushes is always "read"
// on the app side however little the user had to do with it.
const USER_ARGUMENTS = "src/commands.ts";
const APP_ARGUMENTS = "src/cli-args.ts";
const ARGUMENT_READERS = [USER_ARGUMENTS, APP_ARGUMENTS];

function flagLiterals(source) {
  return Array.from(source.matchAll(/"(--[a-z][a-z-]*)"/g)).map((match) => match[1]);
}

test("the reader finds the flags these files are known to hold", () => {
  const found = new Set(ARGUMENT_READERS.flatMap((file) => flagLiterals(read(file))));
  for (const known of ["--base", "--staged", "--whitespace", "--include-untracked"]) {
    assert.ok(found.has(known), `the flag reader found nothing for ${known} — it is reading the wrong thing, `
      + `so any absence it reports below is its own bug. Found: ${JSON.stringify([...found])}`);
  }
});

test("a token the CLI accepts is either advertised or declared internal", () => {
  const declared = new Set([
    ...CLI_OPTIONS.flatMap((option) => [option.flag, option.alias]).filter(Boolean),
    ...CLI_INTERNAL_ARGS.map((entry) => entry.flag),
  ]);
  const stray = [];
  for (const file of ARGUMENT_READERS) {
    for (const flag of new Set(flagLiterals(read(file)))) {
      if (!declared.has(flag)) stray.push(`${file} accepts ${flag}`);
    }
  }
  assert.deepEqual(stray, [], "a flag the code reads is in neither table, so the help text does not mention it "
    + "and nothing says it is deliberate. Add it to CLI_OPTIONS in src/cli-surface.ts, or to CLI_INTERNAL_ARGS "
    + "there with the reason a user should not be told about it.");
});

test("an option the help text advertises is one a user can change something with", () => {
  const sources = read(USER_ARGUMENTS);
  const unread = CLI_OPTIONS.filter((option) => {
    if (option.forward !== "handled") return false;
    const spellings = [option.flag, option.alias].filter(Boolean);
    return !spellings.some((flag) => sources.includes(`readOption(args, "${flag}")`)
      || sources.includes(`args.includes("${flag}")`) || sources.includes(`rawArgs.includes("${flag}")`));
  }).map((option) => option.flag);
  assert.deepEqual(unread, [], "the help text lists this option and nothing reads it from the arguments the "
    + "user typed, so passing it does nothing. --include-untracked was listed for a year while the CLI "
    + "forwarded it unconditionally. Give it a forward mode the loop in launchReviewApp honours, or move it "
    + "to CLI_INTERNAL_ARGS in src/cli-surface.ts.");
});

test("every option that takes a value is in the set the positional reader skips over", () => {
  const values = cliValueOptions();
  const missing = CLI_OPTIONS.filter((option) => option.value && !values.has(option.flag)).map((o) => o.flag);
  assert.deepEqual(missing, [], "positionalPath() would read this option's value as the path to open.");
});

test("a command is in the help text and in both READMEs", () => {
  const help = `${commandsHelp()}\n${optionsHelp()}`;
  const readmes = { "README.md": read("README.md"), "README_KR.md": read("README_KR.md") };
  assert.ok(readmes["README.md"].includes("install-app"), "the README reader found nothing for a command both "
    + "READMEs are known to document, so its absences below mean nothing");
  const missing = [];
  for (const command of CLI_COMMANDS) {
    if (!help.includes(command.name)) missing.push(`printHelp is missing ${command.name}`);
    for (const [file, text] of Object.entries(readmes)) {
      if (!text.includes(`kakapo ${command.name}`)) missing.push(`${file} is missing ${command.name}`);
    }
  }
  assert.deepEqual(missing, [], "a command users can type is documented in one place and not the others.");
});
