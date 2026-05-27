// Babel config used ONLY by Jest (see jest.config.js).
//
// expo-server-sdk v6 is published as pure ESM ("type": "module" in its
// package.json). Our project compiles to CommonJS via `tsc` (see
// tsconfig.json -> "module": "commonjs"), so we cannot import the ESM build
// at test time without a transform. The jest.config.js entry that hands
// `.js`/`.mjs` files to babel-jest plus a `transformIgnorePatterns`
// allowlist for `expo-server-sdk` is what makes this work.
//
// Scope: ts-jest still handles every `.ts` file (our source and tests). This
// babel config therefore only ever runs against the SDK's published `.js`
// inside node_modules/expo-server-sdk/* and its ESM sub-deps that we
// allow-list in jest.config.js. We intentionally keep this config minimal.
//
// Three transforms are needed for expo-server-sdk v6 specifically:
//   1. @babel/preset-env  — lowers ESM `import`/`export` to CJS.
//   2. babel-plugin-transform-import-meta — rewrites `import.meta.url` (the
//      SDK uses it with `createRequire` to load its package.json for the
//      sdkVersion header) to a CJS-compatible `pathToFileURL(__filename)`.
//   3. The inline plugin below renames the SDK's top-level binding
//      `const require = createRequire(import.meta.url)` to `__sdkRequire`
//      so it no longer shadows the CJS `require` that preset-env injects
//      for the ESM-→-CJS rewrite (TDZ "Cannot access '_require' before
//      initialization" otherwise).
module.exports = (api) => {
  api.cache.forever();
  return {
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' } }],
    ],
    plugins: [
      // Inline plugin that handles two coupled rewrites for the SDK:
      //   (a) Replace `import.meta.url` with a constant pathToFileURL
      //       expression that does NOT use the local `require` name (we
      //       inline the `node:url` import instead, so the replacement is
      //       independent of our rename pass below).
      //   (b) Rename a top-level `const require = createRequire(...)` binding
      //       to `__sdkRequire` so it doesn't shadow the CJS `require` that
      //       @babel/preset-env injects when lowering the file's ESM
      //       imports. Otherwise the very first hoisted `require('node:assert')`
      //       hits a TDZ on `require`.
      // Both transforms only run when the file imports `createRequire`
      // from `node:module` — the exact SDK shape — so we cannot mis-fire
      // on unrelated transformed files.
      function sdkEsmInterop({ types: t, template }) {
        return {
          name: 'expo-sdk-esm-interop',
          visitor: {
            Program: {
              enter(path) {
                const usesCreateRequire = path.node.body.some(
                  (node) =>
                    t.isImportDeclaration(node) &&
                    node.source.value === 'node:module' &&
                    node.specifiers.some(
                      (s) =>
                        t.isImportSpecifier(s) &&
                        t.isIdentifier(s.imported) &&
                        s.imported.name === 'createRequire',
                    ),
                );
                if (!usesCreateRequire) return;
                path.scope.rename('require', '__sdkRequire');
                // Inject `import { pathToFileURL as __sdkPathToFileURL } from 'node:url';`
                // at the top so import-meta replacement can use it without
                // referencing the local `__sdkRequire` binding.
                const urlImport = t.importDeclaration(
                  [
                    t.importSpecifier(
                      t.identifier('__sdkPathToFileURL'),
                      t.identifier('pathToFileURL'),
                    ),
                  ],
                  t.stringLiteral('node:url'),
                );
                path.unshiftContainer('body', urlImport);
              },
            },
            MetaProperty(path) {
              // Replace any `import.meta.url` (or bare `import.meta`) with
              // an expression evaluable in CJS. We only do this in files
              // that matched the createRequire shape above; guard via the
              // presence of our injected import.
              const program = path.findParent((p) => p.isProgram());
              if (!program) return;
              const hasInjected = program.node.body.some(
                (n) =>
                  t.isImportDeclaration(n) &&
                  n.source.value === 'node:url' &&
                  n.specifiers.some(
                    (s) =>
                      t.isImportSpecifier(s) &&
                      t.isIdentifier(s.local) &&
                      s.local.name === '__sdkPathToFileURL',
                  ),
              );
              if (!hasInjected) return;
              if (
                t.isMetaProperty(path.node) &&
                t.isIdentifier(path.node.meta, { name: 'import' }) &&
                t.isIdentifier(path.node.property, { name: 'meta' })
              ) {
                // Replace the enclosing `import.meta.url` member expression
                // if that's the parent; otherwise replace just import.meta.
                const parent = path.parentPath;
                if (
                  parent.isMemberExpression() &&
                  t.isIdentifier(parent.node.property, { name: 'url' })
                ) {
                  parent.replaceWith(
                    template.expression.ast(
                      `__sdkPathToFileURL(__filename).toString()`,
                    ),
                  );
                } else {
                  path.replaceWith(
                    template.expression.ast(
                      `({ url: __sdkPathToFileURL(__filename).toString() })`,
                    ),
                  );
                }
              }
            },
          },
        };
      },
    ],
  };
};
