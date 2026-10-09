import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConfiguredShoppingModel, createMockRuntime, runShoppingAgent, ShoppingModelClient,
  type ShoppingModelOptions, type ShoppingModelProtocol } from './index';

const protocols: ShoppingModelProtocol[] = ['openai', 'anthropic', 'gemini'];
const key = 'local-protocol-test-key';
const intent = { query: '拿铁', quantity: 1, items: [{ query: '拿铁', quantity: 1 }], max_total_minor: 3000,
  purchase_shape: 'same_product', requested_fulfillment: 'pickup', explanation: '一杯拿铁。' };
const tool = { type: 'function' as const, function: { name: 'search', description: '查询目录',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

function result(protocol: ShoppingModelProtocol, name?: string, args: unknown = {}, id?: string): Response {
  if (protocol === 'anthropic') return Response.json({ role: 'assistant', stop_reason: name ? 'tool_use' : 'end_turn',
    content: name ? [{ type: 'text', text: '根据已验证状态操作。' }, { type: 'tool_use', id: id ?? 'native_call', name, input: args }]
      : [{ type: 'text', text: '等待用户确认。' }] });
  if (protocol === 'gemini') return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: name
    ? [{ text: '根据已验证状态操作。' }, { functionCall: { name, args, ...(id ? { id } : {}) }, thoughtSignature: `signature-${name}` }]
    : [{ text: '等待用户确认。' }] } }] });
  return Response.json({ choices: [{ finish_reason: name ? 'tool_calls' : 'stop', message: { role: 'assistant', content: '根据已验证状态操作。',
    ...(name ? { tool_calls: [{ id: id ?? 'native_call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) } }] });
}
function capture(options: Partial<ShoppingModelOptions>, responses: (() => Response)[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const model = new ShoppingModelClient({ apiKey: key, ...options, fetch: (async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses.shift(); if (!next) throw new Error('Unexpected provider request'); return next();
  }) as typeof fetch });
  return { model, requests };
}

// Contract fixture for Google's stable v1 discovery schema. Unlike a permissive
// response stub, this rejects the v1beta-only declaration that caused HTTP 400.
function assertGeminiV1Schema(value: unknown): void {
  expect(value).toBeObject();
  const schema = value as Record<string, unknown>;
  const fields = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'format', 'nullable', 'title', 'pattern']);
  for (const field of Object.keys(schema)) expect(fields.has(field)).toBe(true);
  expect(typeof schema.type).toBe('string');
  expect(['OBJECT', 'ARRAY', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'NULL']).toContain(String(schema.type));
  for (const field of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']) {
    if (schema[field] !== undefined) expect(schema[field]).toMatch(/^[0-9]+$/);
  }
  if (schema.enum !== undefined) {
    expect(schema.type).toBe('STRING'); expect(schema.enum).toBeArray();
    for (const entry of schema.enum as unknown[]) expect(typeof entry).toBe('string');
  }
  if (schema.required !== undefined) {
    expect(schema.required).toBeArray();
    for (const entry of schema.required as unknown[]) expect(typeof entry).toBe('string');
  }
  if (schema.properties !== undefined) {
    expect(schema.properties).toBeObject();
    for (const property of Object.values(schema.properties as Record<string, unknown>)) assertGeminiV1Schema(property);
  }
  if (schema.items !== undefined) assertGeminiV1Schema(schema.items);
}

function assertGeminiV1Request(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction', 'toolConfig', 'tools']);
  const declarations = (body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations;
  for (const declaration of declarations) {
    for (const field of Object.keys(declaration)) expect(['name', 'description', 'parameters']).toContain(field);
    expect(declaration).not.toHaveProperty('parametersJsonSchema');
    if (declaration.parameters !== undefined) assertGeminiV1Schema(declaration.parameters);
  }
}

describe('user-configured model protocols', () => {
  test.each([
    ['openai', 'https://gateway.example/v1', 'vendor/model', 'https://gateway.example/v1/chat/completions'],
    ['openai', 'https://gateway.example/v1/chat/completions/', 'vendor/model', 'https://gateway.example/v1/chat/completions'],
    ['openai', 'http://127.0.0.1:11434/v1', 'local-model', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-6', 'https://api.anthropic.com/v1/messages'],
    ['anthropic', 'https://gateway.example/v1/', 'claude-sonnet-4-6', 'https://gateway.example/v1/messages'],
    ['anthropic', 'https://gateway.example/proxy/v1/messages/', 'claude-sonnet-4-6', 'https://gateway.example/proxy/v1/messages'],
    ['gemini', 'https://generativelanguage.googleapis.com', 'gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'],
    ['gemini', 'https://gateway.example/v1beta', 'models/gemini-2.5-flash', 'https://gateway.example/v1beta/models/gemini-2.5-flash:generateContent'],
    ['gemini', 'https://gateway.example/v1/models/', 'gemini-2.5-flash', 'https://gateway.example/v1/models/gemini-2.5-flash:generateContent'],
    ['gemini', 'https://gateway.example/v1beta/models/gemini-2.5-flash:generateContent/', 'gemini-2.5-flash', 'https://gateway.example/v1beta/models/gemini-2.5-flash:generateContent'],
  ] as const)('%s accepts a base or complete endpoint %s without duplicating paths', async (protocol, baseUrl, modelName, endpoint) => {
    const { model, requests } = capture({ protocol, baseUrl, model: modelName }, [() => result(protocol)]);
    const run = model.forRun();
    expect(run.protocol).toBe(protocol); expect(run.model).toBe(modelName);
    expect(await run.complete([{ role: 'user', content: '查询' }], [tool])).toMatchObject({ content: expect.any(String) });
    expect(requests[0]!.url).toBe(endpoint); expect(requests[0]!.url).not.toContain(key);
  });

  test('OpenAI-compatible gateways receive portable tools and no DeepSeek-only fields', async () => {
    const { model, requests } = capture({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }, [() => result('openai', 'search')]);
    await model.complete([{ role: 'system', content: '查询助手' }, { role: 'user', content: '咖啡' }], [tool], 'search');
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${key}`);
    expect(requests[0]!.body).toMatchObject({ model: 'gpt-4.1-mini', tools: [tool], stream: false,
      tool_choice: { type: 'function', function: { name: 'search' } } });
    expect(requests[0]!.body).not.toHaveProperty('thinking');
    const deepseek = capture({}, [() => result('openai')]);
    await deepseek.model.complete([{ role: 'user', content: '咖啡' }], [tool]);
    expect(deepseek.requests[0]!.body.thinking).toEqual({ type: 'disabled' });
  });

  test.each(['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1', 'gpt-6'])('official OpenAI model %s uses the supported completion token limit', async name => {
    const official = capture({ baseUrl: 'https://api.openai.com/v1', model: name }, [() => result('openai')]);
    await official.model.complete([{ role: 'user', content: '咖啡' }], [tool]);
    expect(official.requests[0]!.body).toHaveProperty('max_completion_tokens', 1536);
    expect(official.requests[0]!.body).not.toHaveProperty('max_tokens');
    const compatible = capture({ baseUrl: 'https://gateway.example/v1', model: name }, [() => result('openai')]);
    await compatible.model.complete([{ role: 'user', content: '咖啡' }], [tool]);
    expect(compatible.requests[0]!.body).toHaveProperty('max_tokens', 1536);
    expect(compatible.requests[0]!.body).not.toHaveProperty('max_completion_tokens');
  });

  test.each(protocols)('%s carries native tools through extraction, search and quote without purchasing', async protocol => {
    const scratch = resolve('.codex-tmp/model-protocol-tests'); await mkdir(scratch, { recursive: true });
    const path = await mkdtemp(join(scratch, 'run-')); directories.push(path);
    const { model, requests } = capture({ protocol }, [
      () => result(protocol, 'parse_shopping_intent', intent, 'native_intent'),
      () => result(protocol, 'search', {}, 'native_search'),
      () => result(protocol, 'quote', { entry_ids: ['mock_latte'], reason: '符合预算。' }, 'native_quote'),
    ]);
    const outcome = await runShoppingAgent(await createMockRuntime(path), 'alice',
      { message: '想喝一杯拿铁，预算30元。', quantity: 1, max_total_minor: 3000 }, model);
    expect(outcome.session.phase).toBe('awaiting_confirmation');
    expect(outcome.session.quote!.total_minor).toBe(2800); expect(outcome.session.attempt).toBeUndefined();
    expect(outcome.tool_calls).toBe(2); expect(requests).toHaveLength(3);
    expect(JSON.stringify(outcome)).not.toContain(key);
    const first = requests[0]!, last = requests[2]!;
    if (protocol === 'anthropic') {
      expect(first.headers.get('x-api-key')).toBe(key); expect(first.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(first.headers.has('authorization')).toBe(false);
      expect(first.body.system).toContain('需求解析器');
      expect(first.body.tool_choice).toEqual({ type: 'tool', name: 'parse_shopping_intent', disable_parallel_tool_use: true });
      expect(last.body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      const declared = first.body.tools as { name: string; input_schema: Record<string, unknown> }[];
      expect(declared[0]!.name).toBe('parse_shopping_intent'); expect(declared[0]!.input_schema.type).toBe('object');
      const messages = last.body.messages as { role: string; content: Record<string, unknown>[] }[];
      const use = messages.find(message => message.role === 'assistant')!;
      expect(use.content).toContainEqual({ type: 'tool_use', id: 'native_search', name: 'search', input: {} });
      expect(messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'native_search', content: expect.stringContaining('mock_latte') });
    } else if (protocol === 'gemini') {
      expect(first.headers.get('x-goog-api-key')).toBe(key); expect(first.headers.has('authorization')).toBe(false);
      expect(first.url).not.toContain('?');
      expect(first.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['parse_shopping_intent'] } });
      expect(last.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
      const declarations = first.body.tools as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[];
      expect(declarations[0]!.functionDeclarations[0]!).toMatchObject({ name: 'parse_shopping_intent', parametersJsonSchema: { type: 'object', additionalProperties: false } });
      const contents = last.body.contents as { role: string; parts: Record<string, unknown>[] }[];
      expect(contents.find(content => content.role === 'model')!.parts).toContainEqual({
        functionCall: { id: 'native_search', name: 'search', args: {} }, thoughtSignature: 'signature-search' });
      expect(contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { id: 'native_search', name: 'search', response: { state: { phase: 'candidates' } } } });
    } else {
      const messages = last.body.messages as { role: string; tool_call_id?: string }[];
      expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'native_search' });
    }
    for (const request of requests) expect(JSON.stringify(request.body)).not.toContain(key);
  });

  test('Gemini generates distinct internal call ids and supports older replies with no native id', async () => {
    const { model, requests } = capture({ protocol: 'gemini' }, [() => result('gemini', 'search'), () => result('gemini', 'search')]);
    const first = await model.complete([{ role: 'user', content: '咖啡' }], [tool]);
    const second = await model.complete([{ role: 'user', content: '咖啡' }, { role: 'assistant', ...first },
      { role: 'tool', tool_call_id: first.tool_calls![0]!.id, content: '{"ok":true}' }], [tool]);
    expect(first.tool_calls![0]!.id).not.toBe(second.tool_calls![0]!.id);
    const contents = requests[1]!.body.contents as { parts: Record<string, unknown>[] }[];
    expect(contents.at(-1)!.parts[0]).toEqual({ functionResponse: { name: 'search', response: { ok: true } } });
    expect(first).not.toHaveProperty('thoughtSignature');
  });

  test.each([
    'https://generativelanguage.googleapis.com/v1',
    'https://gateway.example/proxy/v1/models/',
    'https://gateway.example/proxy/v1/models/gemini-2.5-flash:generateContent/',
  ])('Gemini stable v1 %s passes strict native schema validation through a full shopping run', async baseUrl => {
    const scratch = resolve('.codex-tmp/model-protocol-tests'); await mkdir(scratch, { recursive: true });
    const path = await mkdtemp(join(scratch, 'run-')); directories.push(path);
    const requests: Record<string, unknown>[] = [];
    const replies = [
      () => result('gemini', 'parse_shopping_intent', intent, 'native_intent'),
      () => result('gemini', 'search', {}, 'native_search'),
      () => result('gemini', 'quote', { entry_ids: ['mock_latte'], reason: '符合预算。' }, 'native_quote'),
    ];
    const model = new ShoppingModelClient({ apiKey: key, protocol: 'gemini', baseUrl, model: 'gemini-2.5-flash',
      fetch: (async (url, init) => {
        expect(new URL(String(url)).pathname).toMatch(/\/v1\/models\/gemini-2\.5-flash:generateContent$/);
        expect(String(url)).not.toContain(key); expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(key);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; assertGeminiV1Request(body); requests.push(body);
        return replies.shift()!();
      }) as typeof fetch });
    const outcome = await runShoppingAgent(await createMockRuntime(path), 'alice',
      { message: '想喝一杯拿铁，预算30元。', quantity: 1, max_total_minor: 3000 }, model);
    expect(outcome.session.phase).toBe('awaiting_confirmation'); expect(outcome.session.attempt).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests[0]!.systemInstruction).toMatchObject({ parts: [{ text: expect.stringContaining('表单预算是不可突破') }] });
    expect(requests[0]!.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['parse_shopping_intent'] } });
    expect(requests[2]!.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    const parameters = (requests[0]!.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[])[0]!.functionDeclarations[0]!.parameters;
    expect(parameters).toMatchObject({ type: 'OBJECT', required: ['query', 'items', 'quantity', 'max_total_minor', 'purchase_shape', 'requested_fulfillment', 'explanation'],
      properties: { items: { type: 'ARRAY', minItems: '1', maxItems: '10', items: { type: 'OBJECT', required: ['query', 'quantity'],
        properties: { quantity: { type: 'INTEGER', minimum: 1, maximum: 20 } } } },
      purchase_shape: { type: 'STRING', enum: ['same_product', 'mixed_products'] } } });
    const search = (requests[1]!.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations[0]!;
    expect(search.name).toBe('search'); expect(search).not.toHaveProperty('parameters');
    const contents = requests[2]!.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents.find(content => content.role === 'model')!.parts).toContainEqual({
      functionCall: { id: 'native_search', name: 'search', args: {} }, thoughtSignature: 'signature-search' });
    expect(contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { id: 'native_search', name: 'search' } });
  });

  test('Gemini stable v1 connection-check schema never sends unsupported boolean enum values', async () => {
    const { model, requests } = capture({ protocol: 'gemini', baseUrl: 'https://gateway.example/v1' },
      [() => result('gemini', 'connection_check', { ok: true })]);
    const check = { type: 'function' as const, function: { name: 'connection_check', description: 'Harmless connection check',
      parameters: { type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false } } };
    const reply = await model.forRun().complete([{ role: 'system', content: 'Call connection_check with {"ok":true}.' },
      { role: 'user', content: 'Check function calling only.' }], [check], 'connection_check');
    assertGeminiV1Request(requests[0]!.body);
    const parameters = (requests[0]!.body.tools as { functionDeclarations: { parameters: unknown }[] }[])[0]!.functionDeclarations[0]!.parameters;
    expect(parameters).toEqual({ type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] });
    expect(requests[0]!.body.systemInstruction).toEqual({ parts: [{ text: 'Call connection_check with {"ok":true}.' }] });
    expect(requests[0]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['connection_check'] } });
    expect(JSON.parse(reply.tool_calls![0]!.function.arguments)).toEqual({ ok: true });
  });

  test('Gemini stable v1 conversion preserves local rejection of unexpected shopping fields', async () => {
    const { model, requests } = capture({ protocol: 'gemini', baseUrl: 'https://gateway.example/v1' },
      [() => result('gemini', 'parse_shopping_intent', { ...intent, leaked: key })]);
    let caught: unknown;
    try { await model.extractIntent('一杯拿铁。', { quantity: 1, max_total_minor: 3000, merchant_id: 'coffee-demo' }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'invalid_model_response' }); expect(String(caught)).not.toContain(key);
    assertGeminiV1Request(requests[0]!.body);
  });

  test('Gemini v1beta retains the full JSON schema, system instruction and forced tool constraint', async () => {
    const { model, requests } = capture({ protocol: 'gemini', baseUrl: 'https://gateway.example/v1beta' },
      [() => result('gemini', 'connection_check', { ok: true })]);
    const parameters = { type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false };
    await model.forRun().complete([{ role: 'system', content: 'Call connection_check with {"ok":true}.' }, { role: 'user', content: 'Check.' }],
      [{ type: 'function', function: { name: 'connection_check', description: 'Harmless connection check', parameters } }], 'connection_check');
    expect(requests[0]!.url).toBe('https://gateway.example/v1beta/models/gemini-2.5-flash:generateContent');
    const declaration = (requests[0]!.body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations[0]!;
    expect(declaration.parametersJsonSchema).toEqual(parameters); expect(declaration).not.toHaveProperty('parameters');
    expect(requests[0]!.body.systemInstruction).toEqual({ parts: [{ text: 'Call connection_check with {"ok":true}.' }] });
    expect(requests[0]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['connection_check'] } });
  });

  test('Gemini stable v1 refuses unsupported schema features before a provider request with actionable safe text', async () => {
    const { model, requests } = capture({ protocol: 'gemini', baseUrl: 'https://gateway.example/v1' }, []);
    const unsupported = { ...tool, function: { ...tool.function, parameters: { type: 'object',
      properties: { value: { type: 'string', const: key } } } } };
    let caught: unknown;
    try { await model.complete([{ role: 'user', content: '咖啡' }], [unsupported]); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'model_configuration_failed', status: 502 });
    expect(String(caught)).toContain('/v1beta'); expect(String(caught)).not.toContain(key); expect(requests).toHaveLength(0);
  });

  test.each(protocols)('%s rejects malformed JSON, truncated output and concurrent tools', async protocol => {
    const malformed = protocol === 'anthropic' ? [
      { role: 'assistant', stop_reason: 'max_tokens', content: [] },
      { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'search', input: [] }] },
      { role: 'assistant', stop_reason: 'tool_use', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'search', input: {} })) },
    ] : protocol === 'gemini' ? [
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'cut' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'search', args: [] } }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [1, 2].map(() => ({ functionCall: { name: 'search', args: {} } })) } }] },
    ] : [
      { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut' } }] },
      { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{}, {}] } }] },
    ];
    for (const response of [new Response('{'), ...malformed.map(value => Response.json(value))]) {
      const { model } = capture({ protocol }, [() => response]);
      await expect(model.complete([{ role: 'user', content: '咖啡' }], [tool])).rejects.toMatchObject({ code: 'invalid_model_response' });
    }
  });

  test.each(protocols)('%s limits both fetch and response-body reads to the configured timeout', async protocol => {
    for (const slowBody of [false, true]) {
      // Bun's AbortSignal.timeout timer is unref'd. A bounded fixture watchdog keeps
      // the event loop active for synthetic fetch/streams with no network handles.
      let watchdog!: ReturnType<typeof setTimeout>;
      const bounded = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Model request timeout did not fire within the fixture deadline')), 1500);
      });
      const model = new ShoppingModelClient({ apiKey: key, protocol, timeoutMs: 100, fetch: (async (_url, init) => {
        if (slowBody) return new Response(new ReadableStream({ start() { /* deliberately never delivers response bytes */ } }));
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
      }) as typeof fetch });
      try {
        await expect(Promise.race([model.complete([{ role: 'user', content: '咖啡' }], [tool]), bounded]))
          .rejects.toMatchObject({ code: 'model_timeout', status: 504 });
      } finally { clearTimeout(watchdog); }
    }
  });

  test.each(protocols)('%s sanitizes provider authentication errors', async protocol => {
    const { model } = capture({ protocol }, [() => new Response(`provider secret ${key}`, { status: 401 })]);
    try { await model.complete([{ role: 'user', content: '咖啡' }], [tool]); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'model_auth_failed' }); expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain('provider secret'); expect(String(error)).not.toContain('DEEPSEEK_API_KEY');
    }
  });

  test.each([400, 404])('provider HTTP %s reports an actionable configuration problem without its body', async status => {
    const { model } = capture({}, [() => new Response(`provider secret ${key}`, { status })]);
    try { await model.complete([{ role: 'user', content: '咖啡' }], [tool]); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'model_configuration_failed', status: 502 });
      expect(String(error)).toContain('协议'); expect(String(error)).toContain('模型名称'); expect(String(error)).not.toContain(key);
    }
  });

  test('validates protocol, key and mismatched Gemini endpoints without reflecting supplied values', () => {
    expect(() => new ShoppingModelClient({ apiKey: key, protocol: 'unknown' as ShoppingModelProtocol })).toThrow('协议');
    expect(() => new ShoppingModelClient({ apiKey: 'bad\nkey' })).toThrow('API Key');
    expect(() => new ShoppingModelClient({ apiKey: key, protocol: 'gemini', model: 'gemini-2.5-flash',
      baseUrl: 'https://gateway.example/v1beta/models/other-model:generateContent' })).toThrow('模型');
    expect(createConfiguredShoppingModel({ SHOPPING_LLM_API_KEY: key, SHOPPING_LLM_PROTOCOL: 'anthropic' })!.protocol).toBe('anthropic');
    expect(createConfiguredShoppingModel({ DEEPSEEK_API_KEY: key })!.protocol).toBe('openai');
  });
});
