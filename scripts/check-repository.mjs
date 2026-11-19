import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ignored = new Set(['node_modules', 'build', 'dist', '.git', '.local', 'data', 'media']);
function filesUnder(root, directory) {
  const result = [];
  if (!existsSync(path.join(root, directory))) return result;
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}
const portable = (value) => value.split(path.sep).join('/');
const isTest = (file) =>
  /\.(?:test|test-support|bench)\.tsx?$/.test(file) || /\/benchmark\.ts$/.test(file);

export function checkMarkdown(root, file) {
  const failures = [];
  const source = readFileSync(path.join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  const links = [
    ...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g),
    ...source.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi),
  ];
  for (const match of links) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const local = decodeURIComponent(target.split(/[?#]/)[0]);
    if (!local) continue;
    if (/^(?:[A-Za-z]:|\/)/.test(local)) failures.push(`${file}: non-portable link ${target}`);
    else if (!existsSync(path.resolve(root, path.dirname(file), local)))
      failures.push(`${file}: broken link ${target}`);
  }
  return failures;
}

export function checkSourceBoundaries(root, files) {
  const failures = [],
    graph = new Map();
  for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const dependencies = [];
    for (const node of source.statements) {
      if (
        (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const specifier = node.moduleSpecifier.text;
      if (file.startsWith('apps/ui/src/') && specifier.startsWith('node:'))
        failures.push(`${file}: browser code imports ${specifier}`);
      if (!specifier.startsWith('.')) continue;
      const base = path.resolve(root, path.dirname(file), specifier);
      const resolved = [
        base,
        base.replace(/\.js$/, '.ts'),
        base.replace(/\.mjs$/, '.mts'),
        base + '.ts',
        base + '.tsx',
        path.join(base, 'index.ts'),
      ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!resolved) {
        failures.push(`${file}: unresolved import ${specifier}`);
        continue;
      }
      const target = portable(path.relative(root, resolved));
      if (!isTest(file)) {
        if (isTest(target) || target.startsWith('tests/'))
          failures.push(`${file}: production code imports tests`);
        if (
          file.startsWith('apps/ui/src/shared/') &&
          /apps\/ui\/src\/(features|app)\//.test(target)
        )
          failures.push(`${file}: shared code depends on feature ${target}`);
        if (file.startsWith('packages/') && target.startsWith('apps/'))
          failures.push(`${file}: shared contract depends on application ${target}`);
        if (
          (file.startsWith('apps/server/') && target.startsWith('apps/ui/')) ||
          (file.startsWith('apps/ui/') && target.startsWith('apps/server/'))
        )
          failures.push(`${file}: application crosses the server/browser boundary`);
        const typeOnly =
          node.isTypeOnly ||
          node.importClause?.isTypeOnly ||
          (ts.isImportDeclaration(node) &&
            !node.importClause?.name &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.every((item) => item.isTypeOnly));
        if (!typeOnly && /\.tsx?$/.test(target)) dependencies.push(target);
      }
    }
    if (!isTest(file)) graph.set(file, dependencies);
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = (file, chain) => {
    if (visiting.has(file)) {
      failures.push(`Runtime import cycle: ${[...chain, file].join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const target of graph.get(file) ?? []) visit(target, [...chain, file]);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
  return failures;
}

export function checkRepository(root) {
  const sources = ['apps', 'packages'].flatMap((directory) => filesUnder(root, directory));
  const markdown = [
    ...['README.md'].filter((file) => existsSync(path.join(root, file))),
    ...['docs', 'deploy', 'tests', 'scripts', 'apps', 'packages']
      .flatMap((directory) => filesUnder(root, directory))
      .filter((file) => file.endsWith('.md')),
  ];
  return [
    ...checkSourceBoundaries(root, sources),
    ...markdown.flatMap((file) => checkMarkdown(root, file)),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkRepository(fileURLToPath(new URL('../', import.meta.url)));
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
  else console.log('Repository links, source boundaries and runtime import graph are valid.');
}
