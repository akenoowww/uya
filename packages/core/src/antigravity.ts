import type { EffortLevel } from "@ide/protocol";
import type { CliModelDiscovery } from "./cli-models";
import { effortLevels, normalizeEffortLevel } from "./provider-adapter";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function isSafeModelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.startsWith("-")
    && !/[\s\x00-\x1f\x7f]/.test(value);
}

function isPlaceholderModel(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === "default" || lower === "auto";
}

function uniqueModels(candidates: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const item of candidates) {
    if (isSafeModelId(item) && item.toLowerCase() !== "default") {
      seen.add(item);
    }
  }
  return [...seen];
}

function uniqueEfforts(candidates: Iterable<unknown>): EffortLevel[] {
  const seen = new Set<EffortLevel>();
  for (const candidate of candidates) {
    const normalized = normalizeEffortLevel(candidate);
    if (normalized) seen.add(normalized);
  }
  return effortLevels.filter((level) => seen.has(level));
}

function extractOptionValues(value: unknown): unknown[] {
  const options = Array.isArray(value) ? value : [];
  return options
    .flatMap((item) => {
      const group = asObject(item)?.options;
      return Array.isArray(group) ? group : [item];
    })
    .map((item) => {
      if (typeof item === "string") return item;
      const entry = asObject(item);
      return entry?.value ?? entry?.id;
    });
}

function splitEffortSuffix(modelId: string): { base: string; effort: EffortLevel } | undefined {
  const dash = modelId.lastIndexOf("-");
  if (dash <= 0 || dash >= modelId.length - 1) return undefined;
  const effort = normalizeEffortLevel(modelId.slice(dash + 1));
  if (!effort) return undefined;
  const base = modelId.slice(0, dash);
  return isSafeModelId(base) ? { base, effort } : undefined;
}

function groupSuffixedModels(
  rawIds: readonly string[],
  currentModelId?: string,
): CliModelDiscovery {
  const safeIds = uniqueModels(rawIds);
  if (!safeIds.length) return { models: [] };

  const rawSet = new Set(safeIds);
  const grouped = new Map<string, Set<EffortLevel>>();
  for (const id of safeIds) {
    const split = splitEffortSuffix(id);
    if (!split) continue;
    let efforts = grouped.get(split.base);
    if (!efforts) {
      efforts = new Set();
      grouped.set(split.base, efforts);
    }
    efforts.add(split.effort);
  }

  // Collapse `<base>-<effort>` variants only when a base model has multiple effort variants
  // or also appears directly as an unsuffixed base model (keeps fixed slugs like `gpt-oss-120b-medium`).
  const collapsedBases = new Set<string>();
  for (const [base, efforts] of grouped) {
    if (efforts.size >= 2 || rawSet.has(base)) {
      collapsedBases.add(base);
    }
  }

  const models: string[] = [];
  const seen = new Set<string>();
  const modelEfforts: Record<string, EffortLevel[]> = {};

  for (const id of safeIds) {
    const split = splitEffortSuffix(id);
    if (split && collapsedBases.has(split.base)) {
      if (!seen.has(split.base)) {
        seen.add(split.base);
        models.push(split.base);
        modelEfforts[split.base] = uniqueEfforts(grouped.get(split.base) ?? []);
      }
    } else if (!seen.has(id)) {
      seen.add(id);
      models.push(id);
      modelEfforts[id] = collapsedBases.has(id) ? uniqueEfforts(grouped.get(id) ?? []) : [];
    }
  }

  let defaultModel: string | undefined;
  let defaultEffort: EffortLevel | undefined;
  if (currentModelId && isSafeModelId(currentModelId) && !isPlaceholderModel(currentModelId)) {
    const split = splitEffortSuffix(currentModelId);
    if (split && collapsedBases.has(split.base)) {
      defaultModel = split.base;
      defaultEffort = split.effort;
    } else if (seen.has(currentModelId)) {
      defaultModel = currentModelId;
    }
  }

  const supportedEfforts = uniqueEfforts(Object.values(modelEfforts).flat());
  return {
    models: defaultModel ? uniqueModels([defaultModel, ...models]) : models,
    defaultModel,
    ...(supportedEfforts.length ? { supportedEfforts, modelEfforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

export function extractAntigravityAcpModels(result: JsonObject | undefined): CliModelDiscovery {
  if (!result) return { models: [] };

  const modelsSection = asObject(result.models);
  const availableRaw = Array.isArray(modelsSection?.availableModels) ? modelsSection.availableModels : [];
  const availableIds = uniqueModels(availableRaw.map((entry) => {
    if (typeof entry === "string") return entry;
    const obj = asObject(entry);
    return obj?.modelId ?? obj?.id ?? obj?.value;
  }));
  const currentModelId = typeof modelsSection?.currentModelId === "string"
    ? modelsSection.currentModelId
    : undefined;

  const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
  const baseCandidates: unknown[] = [];
  const configEffortCandidates: unknown[] = [];
  let configDefaultModel: string | undefined;
  let defaultEffort: EffortLevel | undefined;

  for (const option of configOptions) {
    const entry = asObject(option);
    if (!entry) continue;
    const keys = [entry.category, entry.id, entry.configId];
    if (keys.some((key) => key === "model")) {
      if (isSafeModelId(entry.currentValue) && !isPlaceholderModel(entry.currentValue)) {
        configDefaultModel ??= entry.currentValue;
      }
      for (const value of extractOptionValues(entry.options)) baseCandidates.push(value);
    } else if (keys.some((key) => key === "thought_level" || key === "effort" || key === "reasoning_effort")) {
      defaultEffort ??= normalizeEffortLevel(entry.currentValue);
      for (const value of extractOptionValues(entry.options)) configEffortCandidates.push(value);
    }
  }

  const baseModels = uniqueModels(baseCandidates);
  if (baseModels.length === 0) {
    const grouped = groupSuffixedModels(availableIds, currentModelId);
    const configEfforts = uniqueEfforts(configEffortCandidates);
    const supportedEfforts = uniqueEfforts([...(grouped.supportedEfforts ?? []), ...configEfforts]);
    return {
      ...grouped,
      ...(supportedEfforts.length ? { supportedEfforts } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  }

  const configEfforts = uniqueEfforts(configEffortCandidates);
  const modelEfforts: Record<string, EffortLevel[]> = {};

  if (availableIds.length > 0) {
    for (const base of baseModels) {
      const prefix = `${base}-`;
      const matched: EffortLevel[] = [];
      for (const id of availableIds) {
        if (!id.startsWith(prefix)) continue;
        const suffixEffort = normalizeEffortLevel(id.slice(prefix.length));
        if (suffixEffort) matched.push(suffixEffort);
      }
      modelEfforts[base] = uniqueEfforts(matched);
    }
  }

  const perModelEfforts = Object.values(modelEfforts).flat();
  const supportedEfforts = uniqueEfforts([...perModelEfforts, ...configEfforts]);
  const defaultModel = configDefaultModel && baseModels.includes(configDefaultModel)
    ? configDefaultModel
    : currentModelId
      ? baseModels.find((base) => currentModelId === base || currentModelId.startsWith(`${base}-`))
      : undefined;

  return {
    models: defaultModel ? uniqueModels([defaultModel, ...baseModels]) : baseModels,
    defaultModel,
    ...(supportedEfforts.length ? { supportedEfforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(Object.keys(modelEfforts).length && supportedEfforts.length ? { modelEfforts } : {}),
  };
}

export function parseAntigravityModelsOutput(raw: string): CliModelDiscovery {
  const ids: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    // Strip ANSI escape codes and carriage-return spinner frames.
    const clean = rawLine
      .replace(/\u001b\[[\d;?]*[ -/]*[@-~]/g, "")
      .split("\r")
      .pop()
      ?.trim();
    if (!clean) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]{1,255})(?:\t+|\s{2,})/.exec(clean);
    if (match?.[1] && isSafeModelId(match[1])) {
      ids.push(match[1]);
    }
  }
  return groupSuffixedModels(ids);
}
