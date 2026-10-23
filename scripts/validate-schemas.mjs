/**
 * 用 DSH 真实校验器验证 task_clock 的 parameters 与 output.schema。
 * 运行：ELECTRON_RUN_AS_NODE=1 "<DSH exe>" scripts/validate-schemas.mjs
 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASAR = process.env.DSH_ASAR ?? resolve(dirname(process.execPath), 'resources/app.asar');
const jsonSchema = await import(pathToFileURL(resolve(ASAR, 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js')).href);
const { assertSupportedJsonSchema, assertObjectJsonSchema } = jsonSchema;

const { apply } = await import('../index.js');

const tools = [];
const created = [];
const agentMap = new Map();
const ctx = {
  logger: { warn() {}, info() {} },
  get: () => undefined,
  on(event, fn) { if (event === 'agent/created') created.push(fn); return () => {}; },
  effect: (fn) => fn(),
  agents: { roots: () => [...agentMap.values()] },
};
apply(ctx, { storeDir: mkdtempSync(join(tmpdir(), 'clock-tools-schema-')) });

const root = {
  id: 'root',
  session: { id: 'session-root' },
  ctx: { effect: (fn) => fn(), tools: { register(tool) { tools.push(tool); return () => {}; } } },
};
agentMap.set('root', root);
created[0]({ agent: root });

if (tools.length !== 1) throw new Error(`expected 1 tool, got ${tools.length}`);
const tool = tools[0];
console.log('tool:', tool.name);
console.log('parameters:', JSON.stringify(tool.parameters));
console.log('output.schema:', JSON.stringify(tool.output.schema));

assertObjectJsonSchema(tool.parameters);
console.log('OK parameters: assertObjectJsonSchema');
assertSupportedJsonSchema(tool.parameters);
console.log('OK parameters: assertSupportedJsonSchema');
assertSupportedJsonSchema(tool.output.schema);
console.log('OK output.schema: assertSupportedJsonSchema');
console.log('SCHEMA_VALIDATION_PASSED');
