import {
  MUSE_MODELS,
  isMuseModel,
  normalizeMuseModel,
  checkMuseHealth,
  handleMuseRequest,
  MUSE_DEFAULT_URL,
} from './upstream.mjs';

export class MuseProvider {
  constructor(config = {}) {
    this.name = 'muse';
    this.label = 'Muse2API Local Gateway';
    this.baseUrl = config.museBaseUrl || MUSE_DEFAULT_URL;
    this.config = config;
  }

  isModel(model) {
    return isMuseModel(model);
  }

  normalizeModel(model) {
    return normalizeMuseModel(model);
  }

  getModels() {
    return MUSE_MODELS.map((id) => ({
      id,
      object: 'model',
      owned_by: 'clickup',
      provider: 'muse',
    }));
  }

  async getStatus() {
    return await checkMuseHealth(this.baseUrl);
  }

  async handleRequest(ctx) {
    return await handleMuseRequest({ ...ctx, config: this.config });
  }
}

export const museProvider = new MuseProvider();
export {
  MUSE_MODELS,
  isMuseModel,
  normalizeMuseModel,
  checkMuseHealth,
  handleMuseRequest,
};
