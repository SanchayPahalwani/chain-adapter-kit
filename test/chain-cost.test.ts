import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  categoryOf,
  duration,
  measure,
  parseShow,
  render,
  summarize,
  type CommitStat,
} from '../scripts/chain-cost.js';

const commit = (hash: string, time: number, files: CommitStat['files']): CommitStat => ({
  hash,
  short: hash.slice(0, 7),
  time,
  date: new Date(time * 1000).toISOString(),
  parents: ['p'],
  subject: `commit ${hash}`,
  files,
});

describe('chain-cost', () => {
  it('G1 sorts each path outside the adapter into its category', () => {
    expect(
      Object.fromEntries(
        [
          'src/core/adapter.ts',
          'src/pipeline/steps.ts',
          'migrations/002_more.sql',
          'src/conformance/suite.ts',
          'src/chains.ts',
          'src/config.ts',
          'scripts/lib/env.ts',
          'test/pipeline-suite.ts',
          'docker-compose.yml',
          'docker/bitcoind/Dockerfile',
          'Makefile',
          '.github/workflows/ci.yml',
          'package.json',
          'package-lock.json',
          'src/adapters/evm/adapter.ts',
          'README.md',
        ].map((p) => [p, categoryOf(p)]),
      ),
    ).toEqual({
      'src/core/adapter.ts': 'core and pipeline',
      'src/pipeline/steps.ts': 'core and pipeline',
      'migrations/002_more.sql': 'core and pipeline',
      'src/conformance/suite.ts': 'conformance suite',
      'src/chains.ts': 'chain registry and config',
      'src/config.ts': 'chain registry and config',
      'scripts/lib/env.ts': 'test harness',
      'test/pipeline-suite.ts': 'test harness',
      'docker-compose.yml': 'infrastructure',
      'docker/bitcoind/Dockerfile': 'infrastructure',
      Makefile: 'infrastructure',
      '.github/workflows/ci.yml': 'infrastructure',
      'package.json': 'infrastructure',
      'package-lock.json': 'infrastructure',
      'src/adapters/evm/adapter.ts': 'other', // another adapter: never expected, so shown apart
      'README.md': 'other',
    });
  });

  it('G2 parses one git show: the commit line, then a numstat line per file, binary as null', () => {
    const output =
      'commit\tabc123full\tabc123\t1794475264\t2026-11-12T14:51:04+05:30\tparent1\tfix: a\tb\n' +
      '\n' +
      '0\t1\tdocker/bitcoind/Dockerfile\n' +
      '-\t-\tlogo.png\n';
    expect(parseShow(output)).toEqual({
      hash: 'abc123full',
      short: 'abc123',
      time: 1794475264,
      date: '2026-11-12T14:51:04+05:30',
      parents: ['parent1'],
      subject: 'fix: a\tb',
      files: [
        { path: 'docker/bitcoind/Dockerfile', added: 0, removed: 1 },
        { path: 'logo.png', added: null, removed: null },
      ],
    });
    expect(parseShow('commit\tr\tr\t1\t2026-01-01T00:00:00Z\t\troot\n').parents).toEqual([]);
  });

  it('G3 sums each file over the commits, splits inside from outside by directory, and times first to last', () => {
    const s = summarize('src/adapters/btc/', [
      commit('bbbbbbbb', 1000 + 3723, [
        { path: 'src/adapters/btc/adapter.ts', added: 5, removed: 2 },
        { path: 'src/chains.ts', added: 1, removed: 1 },
        { path: 'test/btc.test.ts', added: 7, removed: 0 },
      ]),
      commit('aaaaaaaa', 1000, [
        { path: 'src/adapters/btc/adapter.ts', added: 10, removed: 0 },
        { path: 'src/adapters/btc-two/x.ts', added: 4, removed: 0 }, // a prefix, not the directory
        { path: 'src/chains.ts', added: 2, removed: 0 },
      ]),
    ]);
    expect(s.commits.map((c) => c.short)).toEqual(['aaaaaaa', 'bbbbbbb']);
    expect(s.inside).toEqual({ files: 1, added: 15, removed: 2, binary: 0 });
    expect(s.outside).toEqual({ files: 3, added: 14, removed: 1, binary: 0 });
    expect(s.outsideFiles.map((f) => [f.path, f.added, f.removed, f.category])).toEqual([
      ['src/chains.ts', 3, 1, 'chain registry and config'],
      ['test/btc.test.ts', 7, 0, 'test harness'],
      ['src/adapters/btc-two/x.ts', 4, 0, 'other'],
    ]);
    expect(s.byCategory['core and pipeline']).toEqual({
      files: 0,
      added: 0,
      removed: 0,
      binary: 0,
    });
    expect(s.elapsedSeconds).toBe(3723);
    expect(duration(s.elapsedSeconds)).toBe('1 h 2 min 3 s');
    expect(render(s)).toContain('Elapsed:      1 h 2 min 3 s, author time, first to last commit');
  });

  it('G4 refuses a list that is not one piece of work on that directory', () => {
    const one = commit('aaaaaaaa', 1, [{ path: 'src/adapters/btc/a.ts', added: 1, removed: 0 }]);
    expect(() => summarize('src/adapters/btc', [one, one])).toThrow('aaaaaaa is listed twice');
    expect(() => summarize('src/adapters/btc', [{ ...one, parents: ['p1', 'p2'] }])).toThrow(
      'aaaaaaa is a merge',
    );
    expect(() => summarize('src/adapters/sol', [one])).toThrow(
      'no listed commit touches src/adapters/sol/',
    );
    expect(() => summarize('src/adapters/btc', [])).toThrow('no commits');
  });

  describe('on a repository', () => {
    let repo: string;
    const git = (args: string[], date?: string) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: date
          ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
          : process.env,
      }).trim();
    const commitFiles = (files: Record<string, string>, date: string) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git(['add', '.']);
      git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', `at ${date}`], date);
      return git(['rev-parse', '--short', 'HEAD']);
    };
    let listed: string[];

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'chain-cost-'));
      git(['init', '-q']);
      const first = commitFiles(
        { 'src/adapters/btc/a.ts': 'a\nb\n', 'src/chains.ts': 'x\n' },
        '2026-11-12T10:00:00+05:30',
      );
      commitFiles({ 'scripts/other.ts': 'unrelated\n' }, '2026-11-12T10:30:00+05:30'); // not listed
      const last = commitFiles(
        { 'src/adapters/btc/a.ts': 'a\nc\n', 'test/btc.test.ts': '1\n2\n3\n' },
        '2026-11-12T11:15:30+05:30',
      );
      listed = [last, first];
    });
    afterAll(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('G5 measures the listed commits through git show, and only those', () => {
      const s = measure(repo, 'src/adapters/btc', listed);
      expect(s.commits.map((c) => c.date)).toEqual([
        '2026-11-12T10:00:00+05:30',
        '2026-11-12T11:15:30+05:30',
      ]);
      expect(s.inside).toEqual({ files: 1, added: 3, removed: 1, binary: 0 });
      expect(s.outsideFiles.map((f) => f.path)).toEqual(['src/chains.ts', 'test/btc.test.ts']);
      expect(s.elapsedSeconds).toBe(75 * 60 + 30);
    });

    it('G6 names a commit git cannot show', () => {
      expect(() => measure(repo, 'src/adapters/btc', ['0000000'])).toThrow(/git show 0000000/);
    });
  });
});
