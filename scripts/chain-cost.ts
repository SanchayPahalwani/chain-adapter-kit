// What adding a chain took, measured from git (docs/adding-a-chain.md). Given the adapter's
// directory and the commits that make up the work, it prints every file touched outside that
// directory with its lines added and removed and its category, the totals inside the directory,
// outside it and by category, and the author times of the first and last commit. The commits are
// listed one by one, not given as a range, because other work landed between them. Lines are
// summed over the commits (`git show --numstat` of each): a line added by one commit and changed
// by a later one counts in both.
//
//   npx tsx scripts/chain-cost.ts <adapter-dir> <commit>...
//
// <adapter-dir> is relative to the repository root, for example src/adapters/bitcoin. Exit code 2
// for a bad command line, 1 if git cannot show a commit or the list is not one piece of work.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const categories = [
  'core and pipeline',
  'conformance suite',
  'chain registry and config',
  'test harness',
  'infrastructure',
  'other',
] as const;
export type Category = (typeof categories)[number];

// The first rule that matches a path from the repository root decides its category.
const rules: [RegExp, Category][] = [
  [/^src\/(core|pipeline)\//, 'core and pipeline'],
  [/^migrations\//, 'core and pipeline'], // the pipeline's schema
  [/^src\/conformance\//, 'conformance suite'],
  [/^src\/(chains|config)\.ts$/, 'chain registry and config'],
  [/^(scripts|test)\//, 'test harness'],
  [/^(docker-compose\.yml|Makefile|package\.json|package-lock\.json)$/, 'infrastructure'],
  [/^(\.github|docker)\//, 'infrastructure'],
  [/(^|\/)Dockerfile$/, 'infrastructure'],
];

export function categoryOf(path: string): Category {
  return rules.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';
}

export interface FileChange {
  path: string;
  added: number | null; // null: a binary file, which git counts in no lines
  removed: number | null;
}

export interface CommitStat {
  hash: string;
  short: string;
  time: number; // author time, Unix seconds
  date: string; // author time as recorded, ISO 8601 with the author's offset
  parents: string[];
  subject: string;
  files: FileChange[];
}

const FORMAT = 'commit%x09%H%x09%h%x09%at%x09%aI%x09%P%x09%s';

/** One commit's `git show --numstat --format=FORMAT` output. */
export function parseShow(output: string): CommitStat {
  const lines = output.split('\n');
  const header = lines.find((l) => l.startsWith('commit\t'));
  if (!header) throw new Error('no commit line in the git show output');
  const [, hash, short, time, date, parents, ...subject] = header.split('\t');
  if (!hash || !short || !time || !date || parents === undefined) {
    throw new Error(`bad commit line: ${header}`);
  }
  const files: FileChange[] = [];
  for (const line of lines) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const [, added, removed, path] = m as unknown as [string, string, string, string];
    files.push({
      path,
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    });
  }
  return {
    hash,
    short,
    time: Number(time),
    date,
    parents: parents ? parents.split(' ') : [],
    subject: subject.join('\t'),
    files,
  };
}

export interface Totals {
  files: number;
  added: number;
  removed: number;
  binary: number; // files counted in no lines
}

export interface FileCost extends FileChange {
  category: Category;
}

export interface Summary {
  adapterDir: string;
  commits: CommitStat[]; // by author time
  outsideFiles: FileCost[]; // by category, then path
  inside: Totals;
  outside: Totals;
  byCategory: Record<Category, Totals>;
  elapsedSeconds: number; // from the first commit's author time to the last one's
}

const none = (): Totals => ({ files: 0, added: 0, removed: 0, binary: 0 });

function totalOf(files: FileChange[]): Totals {
  const t = none();
  for (const f of files) {
    t.files++;
    if (f.added === null || f.removed === null) t.binary++;
    else {
      t.added += f.added;
      t.removed += f.removed;
    }
  }
  return t;
}

export function summarize(adapterDir: string, commits: CommitStat[]): Summary {
  const dir = adapterDir.replace(/\/+$/, '');
  if (dir === '') throw new Error('the adapter directory is empty');
  if (commits.length === 0) throw new Error('no commits');
  const seen = new Set<string>();
  for (const c of commits) {
    if (seen.has(c.hash)) throw new Error(`${c.short} is listed twice`);
    seen.add(c.hash);
    if (c.parents.length > 1) {
      throw new Error(`${c.short} is a merge: list the commits it brings in instead`);
    }
  }
  const sorted = [...commits].sort((a, b) => a.time - b.time);

  // each file once, its lines summed over the commits
  const byPath = new Map<string, FileChange>();
  for (const c of sorted) {
    for (const f of c.files) {
      const sum = byPath.get(f.path) ?? { path: f.path, added: 0, removed: 0 };
      sum.added = sum.added === null || f.added === null ? null : sum.added + f.added;
      sum.removed = sum.removed === null || f.removed === null ? null : sum.removed + f.removed;
      byPath.set(f.path, sum);
    }
  }
  const all = [...byPath.values()];
  const isInside = (path: string) => path.startsWith(`${dir}/`);
  const inside = all.filter((f) => isInside(f.path));
  if (inside.length === 0) throw new Error(`no listed commit touches ${dir}/`);

  const order = (c: Category) => categories.indexOf(c);
  const outsideFiles = all
    .filter((f) => !isInside(f.path))
    .map((f) => ({ ...f, category: categoryOf(f.path) }))
    .sort((a, b) => order(a.category) - order(b.category) || a.path.localeCompare(b.path));
  const byCategory = Object.fromEntries(
    categories.map((c) => [c, totalOf(outsideFiles.filter((f) => f.category === c))]),
  ) as Record<Category, Totals>;

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    adapterDir: dir,
    commits: sorted,
    outsideFiles,
    inside: totalOf(inside),
    outside: totalOf(outsideFiles),
    byCategory,
    elapsedSeconds: last.time - first.time,
  };
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${m} min ${seconds % 60} s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lines = (n: number | null) => (n === null ? 'binary' : String(n));

export function render(s: Summary): string {
  const out: string[] = [];
  const dir = s.adapterDir;
  out.push(`Adapter directory: ${dir}/`);
  out.push(`Commits: ${s.commits.length}, by author time`);
  for (const c of s.commits) out.push(`  ${c.short}  ${c.date}  ${c.subject}`);

  out.push('', `Files outside ${dir}/, lines summed over the commits:`);
  const width = Math.max(...categories.map((c) => c.length));
  const row = (category: string, added: string, removed: string, rest: string) =>
    `  ${category.padEnd(width)}  ${added.padStart(5)}  ${removed.padStart(7)}  ${rest}`;
  out.push(row('category', 'added', 'removed', 'file'));
  for (const f of s.outsideFiles) {
    out.push(row(f.category, lines(f.added), lines(f.removed), f.path));
  }
  if (s.outsideFiles.length === 0) out.push('  (none)');

  out.push('', 'Totals:');
  const total = (t: Totals) =>
    `${plural(t.files, 'file').padEnd(8)}  +${t.added} -${t.removed}` +
    (t.binary > 0 ? ` (${t.binary} binary)` : '');
  const label = Math.max(width + 2, `outside ${dir}/`.length);
  out.push(`  ${`inside ${dir}/`.padEnd(label)}  ${total(s.inside)}`);
  out.push(`  ${`outside ${dir}/`.padEnd(label)}  ${total(s.outside)}`);
  for (const c of categories) out.push(`    ${c.padEnd(label - 2)}  ${total(s.byCategory[c])}`);

  const first = s.commits[0]!;
  const last = s.commits[s.commits.length - 1]!;
  out.push('', `First commit: ${first.date} (${first.short})`);
  out.push(`Last commit:  ${last.date} (${last.short})`);
  out.push(`Elapsed:      ${duration(s.elapsedSeconds)}, author time, first to last commit`);
  return out.join('\n') + '\n';
}

function gitShow(repo: string, commit: string): string {
  const args = ['-c', 'core.quotePath=false', 'show', '--numstat', '--no-renames', '--no-color'];
  args.push('--no-show-signature', `--format=${FORMAT}`, commit, '--');
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const why = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : String(error);
    throw new Error(`git show ${commit}: ${why}`);
  }
}

/** The summary of `commits` in the repository at `repo`, run through git. */
export function measure(repo: string, adapterDir: string, commits: string[]): Summary {
  return summarize(
    adapterDir,
    commits.map((c) => parseShow(gitShow(repo, c))),
  );
}

function main(argv: string[]): number {
  const [dir, ...commits] = argv;
  if (!dir || commits.length === 0 || argv.some((a) => a.startsWith('-'))) {
    console.error('usage: chain-cost.ts <adapter-dir> <commit>...');
    return 2;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    process.stdout.write(render(measure(root, dir, commits)));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// run as a script, not when a test imports it
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  process.exitCode = main(process.argv.slice(2));
}
