import { clickupProvider, ClickUpProvider } from './clickup/index.mjs';
import { museProvider, MuseProvider } from './muse/index.mjs';

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.defaultProvider = null;
  }

  register(provider, isDefault = false) {
    if (!provider || !provider.name) {
      throw new Error('Provider must have a valid name');
    }
    this.providers.set(provider.name, provider);
    if (isDefault || !this.defaultProvider) {
      this.defaultProvider = provider;
    }
    return this;
  }

  get(name) {
    return this.providers.get(name) || null;
  }

  findForModel(model) {
    if (!model || typeof model !== 'string') return this.defaultProvider;
    for (const provider of this.providers.values()) {
      if (typeof provider.isModel === 'function' && provider.isModel(model)) {
        return provider;
      }
    }
    return this.defaultProvider;
  }

  async getAllModels() {
    const list = [];
    for (const provider of this.providers.values()) {
      if (typeof provider.getModels === 'function') {
        const models = await provider.getModels();
        if (Array.isArray(models)) {
          list.push(...models);
        }
      }
    }
    return list;
  }

  async getAllStatuses() {
    const statuses = {};
    for (const [name, provider] of this.providers.entries()) {
      if (typeof provider.getStatus === 'function') {
        try {
          statuses[name] = await provider.getStatus();
        } catch (err) {
          statuses[name] = { error: err.message, online: false };
        }
      }
    }
    return statuses;
  }
}

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(clickupProvider, true);
providerRegistry.register(museProvider, false);

export {
  clickupProvider,
  ClickUpProvider,
  museProvider,
  MuseProvider,
};
