import { z } from 'zod';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';

// Same Host-only projection contract as dsh-tool-subagent. Never edit or mint
// an authorization event here; only the existing user-owned settings do that.
function assertAllowedModelRoutes(routes) {
  if (!Array.isArray(routes)) throw new Error('subagent model selection requires an array of routes');
  const seen = new Set();
  for (const route of routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route) || typeof route.provider !== 'string' || !route.provider.length || typeof route.model !== 'string' || !route.model.length) throw new Error('subagent model selection requires non-empty provider and model ids');
    const key = `${route.provider}\0${route.model}`;
    if (seen.has(key)) throw new Error('subagent model selection repeats a route');
    seen.add(key);
  }
}
export const modelSelectionPolicyProjection = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()).min(1).nullable(),
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy;
    const { allowedModels } = event.data;
    assertAllowedModelRoutes(allowedModels);
    if (!allowedModels.length) throw new Error('subagent/model-selection-policy requires at least one route');
    return allowedModels;
  },
};

function routesFor(handle, parent) {
  const recorded = handle.stateOf(parent.session);
  if (recorded !== null && recorded !== undefined) {
    // Fail closed even if a malformed projection is supplied by an adapter.
    modelSelectionPolicyProjection.stateSchema.parse(recorded);
    assertAllowedModelRoutes(recorded);
    return recorded.map(route => ({ ...route }));
  }
  const { provider, model } = parentAgentOptionsForDelegation(parent);
  if (!provider || !model) throw new Error('Cannot resolve the parent LLM route');
  return [{ provider, model }];
}
function field(value, label) {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.trim() !== value)) throw new Error(`${label} must be a non-empty exact id`);
}
function llmFor(ctx) {
  const llm = ctx.get('llm');
  if (!llm) throw new Error('LLM service is unavailable');
  return llm;
}

/** Validate before reserving any member name or starting a child. */
export async function prepareTeammateModel(ctx, handle, parent, backendName, selection, signal) {
  if (selection === undefined) return undefined; // The old inheritance path is unchanged.
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Invalid teammate model selection');
  const { provider, model, reasoningEffort } = selection;
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined;
  field(provider, 'provider'); field(model, 'model'); field(reasoningEffort, 'reasoningEffort');
  if ((provider === undefined) !== (model === undefined)) throw new Error('Teammate provider and model must be supplied together');
  signal.throwIfAborted();
  const backend = ctx.subagents.getProvider(backendName);
  if (!backend?.capabilities.agentOptions) throw new Error('This teammate backend does not support model selection');
  const parentOptions = parentAgentOptionsForDelegation(parent);
  const effectiveProvider = provider ?? parentOptions.provider;
  const effectiveModel = model ?? parentOptions.model;
  if (!routesFor(handle, parent).some(route => route.provider === effectiveProvider && route.model === effectiveModel)) throw new Error(`Teammate LLM route "${effectiveProvider}/${effectiveModel}" is not allowed for this Session`);
  const routeChanged = effectiveProvider !== parentOptions.provider || effectiveModel !== parentOptions.model;
  const effectiveEffort = reasoningEffort ?? (routeChanged ? undefined : parentOptions.reasoningEffort);
  await llmFor(ctx).resolveCallConfig({
    provider: effectiveProvider, model: effectiveModel,
    ...(effectiveEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveEffort) }),
  }, signal);
  signal.throwIfAborted();
  if (ctx.subagents.getProvider(backendName) !== backend) throw new Error('Teammate backend changed during model validation; retry the request');
  // Pin exactly what was validated, including inherited effort. An own undefined
  // effort deliberately clears a newly changed parent's effort in core's spread
  // merge, while still leaving the selected model's default unmaterialized.
  return {
    // Carry the actual validated backend object across the Promise boundary.
    // Re-reading the registry in the caller could bless a replacement backend.
    backend,
    agentOptions: {
      provider: effectiveProvider,
      model: effectiveModel,
      reasoningEffort: effectiveEffort === undefined ? undefined : ReasoningEffortId(effectiveEffort),
    },
  };
}

/** Scoped discovery, because the stock Team profile disables ordinary subagent tools. */
export async function listTeammateModels(ctx, handle, parent, request, signal) {
  field(request.provider, 'provider'); field(request.model, 'model');
  if (request.model !== undefined && request.provider === undefined) throw new Error('model requires provider');
  const routes = routesFor(handle, parent);
  const llm = llmFor(ctx);
  signal.throwIfAborted();
  if (request.provider === undefined) {
    return llm.listProviders().filter(provider => routes.some(route => route.provider === provider.id)).map(provider => `${provider.id} — ${provider.name}`).join('\n') || '(no allowed LLM providers)';
  }
  const allowed = routes.filter(route => route.provider === request.provider);
  if (!allowed.length) throw new Error('LLM provider is not allowed for this Session');
  if (!llm.listProviders().some(provider => provider.id === request.provider)) throw new Error('LLM provider is not registered');
  if (request.model === undefined) {
    // Resolve exact authorized routes: do not hide an allowed custom model merely
    // because the adapter does not advertise it in its static model directory.
    const models = await Promise.all(allowed.map(route => llm.resolveModelInfo(route.provider, route.model, signal)));
    signal.throwIfAborted();
    return models.map(model => `${request.provider}/${model.id} — ${model.name}`).join('\n');
  }
  if (!allowed.some(route => route.model === request.model)) throw new Error('LLM model is not allowed for this Session');
  const model = await llm.resolveModelInfo(request.provider, request.model, signal);
  signal.throwIfAborted();
  const efforts = model.reasoning?.efforts.map(effort => `${effort.id}${model.reasoning.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`).join('\n') || '(no advertised reasoning efforts)';
  return `${request.provider}/${model.id} — ${model.name}\nReasoning efforts:\n${efforts}`;
}
