// Read-only AST inventory. Does not load application code, initialize Nest,
// construct database clients, compile, or access any network/service.
const fs = require('fs');
const path = require('path');
const ts = require('/home/user/workspace/deps/backend/node_modules/typescript/lib/typescript.js');
const root = '/home/user/workspace/wt/RO-backend';
const modules = new Map();
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(absolute);
    return entry.name.endsWith('.module.ts') ? [absolute] : [];
  });
}
for (const file of files(path.join(root, 'src'))) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  // Resolve by file plus exported class, not class name: this repository has
  // two distinct InsightsModule classes in different directories.
  const importedModules = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!specifier.startsWith('.') || !bindings || !ts.isNamedImports(bindings)) continue;
    const target = path.resolve(path.dirname(file), specifier + '.ts');
    for (const binding of bindings.elements) {
      importedModules.set(binding.name.text, `${target}#${(binding.propertyName || binding.name).text}`);
    }
  }
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const decorator of ts.getDecorators(node) || []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'Module') continue;
        const metadata = call.arguments[0];
        if (!metadata || !ts.isObjectLiteralExpression(metadata)) continue;
        let imports = [];
        let providers = [];
        for (const property of metadata.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) continue;
          const propertyName = property.name.getText(source);
          if (propertyName === 'imports') {
            imports = property.initializer.elements.flatMap((item) => {
              if (ts.isIdentifier(item)) return [item.text];
              const text = item.getText(source);
              const forward = text.match(/forwardRef\s*\(\s*\(\s*\)\s*=>\s*(\w+)/);
              return forward ? [forward[1]] : [];
            });
          }
          if (propertyName === 'providers') {
            providers = property.initializer.elements
              .filter((item) => ts.isIdentifier(item) && item.text === 'PrismaService')
              .map((item) => ({ line: source.getLineAndCharacterOfPosition(item.getStart(source)).line + 1 }));
          }
        }
        const resolvedImports = imports.map((name) => importedModules.get(name) || `${file}#${name}`);
        modules.set(`${file}#${node.name.text}`, { module: node.name.text, file: path.relative(root, file), imports: resolvedImports, providers });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const visited = new Set();
function reachable(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const module = modules.get(name);
  if (!module) return;
  module.imports.forEach(reachable);
}
reachable(`${path.join(root, 'src/app.module.ts')}#AppModule`);
const prisma = [...modules.values()]
  .filter((item) => visited.has(`${path.join(root, item.file)}#${item.module}`) && item.providers.length)
  .map(({ imports, ...item }) => item)
  .sort((a, b) => a.file.localeCompare(b.file));
const count = prisma.reduce((total, item) => total + item.providers.length, 0);
console.log(JSON.stringify({
  method: 'TypeScript AST only; resolves static named imports by file and exported class from AppModule; counts bare PrismaService provider registrations',
  backend_head: '5230306cb63df7290459bb362340a42f385f39d5',
  registration_count: count,
  registrations: prisma,
  capacity_scenarios: [5, 10].map((pool) => ({
    connection_limit_per_client: pool,
    one_machine_configured_pool_maximum: count * pool,
    two_machines_configured_pool_maximum: count * pool * 2,
    note: 'Configured maxima, not measured open connections; transaction pooling decouples these client connections from direct Postgres slots.'
  }))
}, null, 2));
