import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

// LS-1185R6 check (a) permits only path/import changes to the original
// B-TEST assertions. This checks that source-preservation requirement,
// not a claim that Reflect.get weakens the parse-diagnostic predicate.
const ORIGINAL_ASSERTION =
  'expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);';

function runtimeAssertion(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText.replace(/\s+/g, '').replace(/;$/, '');
}

describe('LS-1185R6 B3: original B-TEST assertions change only for paths or imports', () => {
  it('erases original type syntax without changing its assertion operand', () => {
    expect(runtimeAssertion(ORIGINAL_ASSERTION)).toBe(
      'expect(parsed.parseDiagnostics).toEqual([])',
    );
  });

  it.each([
    'ls-1185r2-caller-forms.spec.ts',
    'ls-1185r2-dynamic-forms.spec.ts',
  ])('preserves the original parse-diagnostic assertion in %s', (name) => {
    const source = ts.createSourceFile(
      name,
      readFileSync(join(__dirname, name), 'utf8'),
      ts.ScriptTarget.ES2021,
      true,
    );
    const assertions: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'toEqual' &&
          node.getText(source).includes('parseDiagnostics')) {
        assertions.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(assertions).toHaveLength(1);
    expect(runtimeAssertion(assertions[0])).toBe(runtimeAssertion(ORIGINAL_ASSERTION));
  });
});
