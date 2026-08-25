import { expect, test } from 'bun:test'

import { compileRpnExpression, evaluateCompiledExpression } from './rpn'

test('preserves register and label evaluation with lazy evaluator state', () => {
  const expression = compileRpnExpression('1 s0 g1 99 :1 l0', {
    sourcePath: 'test.xml',
    sourceExpression: '1 s0 g1 99 :1 l0',
    diagnostics: [],
  })

  if (expression == null) throw new Error('expression did not compile')
  expect(evaluateCompiledExpression(expression, { readVariable: () => 0 })).toBe(1)
})
